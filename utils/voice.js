'use strict';

// Enforcement, as opposed to instruction.
//
// utils/prompt.js *asks* the model to write like the server: lowercase, short,
// no trailing full stop, server slang. A model complies for a sentence or two
// and then drifts back to the register it was trained on — polished,
// capitalised, helpful, and instantly recognisable as a bot.
//
// A Markov chain never drifts, because it is physically incapable of emitting
// anything the server did not write. This module is the closest deterministic
// equivalent: it takes the model's output and the measured dialect profile and
// forces the output to match the server's observed habits, whatever the model
// felt like doing. Prompting sets the direction; this decides the outcome.
//
// Everything here is measured, never assumed: if a server does capitalise and
// does end sentences with full stops, the profile says so and nothing changes.

// Openers that mark a reply as customer service rather than conversation.
const ASSISTANT_OPENERS = [
    /^(sure|certainly|absolutely|of course|got it|understood|alright|okay|ok)[,!.]?\s+/i,
    /^(great|good|excellent|interesting)\s+(question|point|idea)[,!.]?\s*/i,
    /^(ah|oh|well)[,]\s+/i,
    /^(as an ai|as a language model)[^.!?]*[.!?]\s*/i,
    /^here'?s?\s+(a|the|what|my)\b[^:\n]{0,40}:\s*/i,
];

// Trailing offers of further assistance. Nobody in a group chat says these.
const ASSISTANT_CLOSERS = [
    /\s*(let me know|lmk)\b[^.!?]*[.!?]?\s*$/i,
    /\s*hope (that|this) helps[^.!?]*[.!?]?\s*$/i,
    /\s*(feel free to|don'?t hesitate to)\b[^.!?]*[.!?]?\s*$/i,
    /\s*if you (have|need|want)\b[^.!?]*\?\s*$/i,
    /\s*(happy to help|glad to help)[^.!?]*[.!?]?\s*$/i,
    /\s*is there anything else\b[^.!?]*\?\s*$/i,
];

// Whole sentences that only exist to disclaim.
const DISCLAIMER_SENTENCES = [
    /\b(as an ai|i'?m an ai|i am an ai|as a language model|i don'?t have personal)\b[^.!?]*[.!?]/gi,
    /\b(i should note|it'?s worth noting|please note) that\b[^.!?]*[.!?]/gi,
];

function stripAssistantTics(text) {
    let result = text;

    for (const pattern of DISCLAIMER_SENTENCES) {
        result = result.replace(pattern, ' ');
    }

    // Openers and closers stack ("Sure! Great question. ..."), so run each set
    // until it stops matching rather than once.
    for (let pass = 0; pass < 3; pass++) {
        const before = result;
        for (const pattern of ASSISTANT_OPENERS) result = result.replace(pattern, '');
        for (const pattern of ASSISTANT_CLOSERS) result = result.replace(pattern, '');
        if (result === before) break;
    }

    return result.replace(/[ \t]{2,}/g, ' ').trim();
}

// Models pick up the "Name: message" format from the conversation history and
// start signing their own replies with it.
function stripSpeakerPrefix(text, botName) {
    if (!botName) return text;
    const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`^\\s*${escaped}\\s*:\\s*`, 'i'), '').trim();
}

// Because history is formatted as "Name: message", a model will sometimes keep
// going and write everyone else's replies too. Keep only the bot's own turn:
// cut at the first line that looks like somebody else speaking.
function cutRolePlay(text) {
    const lines = text.split('\n');
    const kept = [];

    for (const line of lines) {
        // A speaker label is a name: at most two words, no sentence structure.
        // Matching any short run of characters before a colon would also eat
        // real sentences ("we do the thing: win the round"), so the word count
        // is the discriminator, not just the length.
        const looksLikeSpeaker = /^\s*[A-Za-z0-9_.]+(?: [A-Za-z0-9_.]+)?:\s+\S/.test(line) &&
            !/^\s*https?:/i.test(line);
        if (kept.length > 0 && looksLikeSpeaker) break;
        kept.push(line);
    }

    return kept.join('\n').trim();
}

// Masking placeholders are lowercase ASCII, not digits or control characters:
// a digit placeholder collides with numbers the message already contains
// ("i have 3 apples" would restore block 3 over the "3"), and control bytes
// corrupt the file. This sentinel survives toLowerCase unchanged, which is
// what lets the same scheme protect both code and case-sensitive tokens.
const MASK_PREFIX = 'zqxmask';
const MASK_SUFFIX = 'xqz';
const MASK_PATTERN = new RegExp(`${MASK_PREFIX}(\\d+)${MASK_SUFFIX}`, 'g');

function mask(text, pattern) {
    const saved = [];
    const masked = text.replace(pattern, (match) => {
        saved.push(match);
        return `${MASK_PREFIX}${saved.length - 1}${MASK_SUFFIX}`;
    });
    return { masked, saved };
}

function unmask(masked, saved) {
    return masked.replace(MASK_PATTERN, (whole, index) => saved[Number(index)] ?? whole);
}

// URLs, custom emoji and Discord mentions are case-sensitive; everything else
// follows the server.
function lowercasePreservingTokens(text) {
    const { masked, saved } = mask(text, /https?:\/\/\S+|<a?:\w+:\d+>|<[@#][!&]?\d+>/g);
    return unmask(masked.toLowerCase(), saved);
}

// Applies the server's measured casing. Only fires when the habit is
// overwhelming — a server that is merely mostly-lowercase is left alone.
function matchCase(text, style) {
    if (!style || typeof style.lowercaseRatio !== 'number') return text;
    if (style.lowercaseRatio < 0.85) return text;

    // Fenced and inline code keeps its casing regardless.
    const { masked, saved } = mask(text, /```[\s\S]*?```|`[^`\n]*`/g);
    return unmask(lowercasePreservingTokens(masked), saved);
}

// Applies the server's measured sentence-ending habit. Full stops only —
// stripping "!" or "?" would change meaning, and a server that omits full
// stops still uses those.
function matchPunctuation(text, style) {
    if (!style || typeof style.punctuationRatio !== 'number') return text;
    if (style.punctuationRatio > 0.25) return text;

    return text
        .split('\n')
        .map((line) => {
            const trimmed = line.trimEnd();
            if (trimmed.endsWith('```') || /^\s*[-*>#]/.test(trimmed)) return line;
            // Only a single trailing full stop; "..." is doing something else.
            return trimmed.replace(/(?<![.!?])\.$/, '');
        })
        .join('\n');
}

// A reply cut off by max_tokens ends mid-word. Better to drop the dangling
// fragment than to publish half a sentence.
function trimDanglingSentence(text, wasTruncated) {
    if (!wasTruncated) return text;
    const lastBreak = Math.max(
        text.lastIndexOf('.'),
        text.lastIndexOf('!'),
        text.lastIndexOf('?'),
        text.lastIndexOf('\n')
    );
    // Only trim when doing so leaves a substantial reply behind — otherwise a
    // long unpunctuated answer would be cut down to its first few words.
    if (lastBreak > text.length * 0.4) return text.slice(0, lastBreak + 1).trim();
    return text.trim();
}

// The full pipeline. Order matters: tics and role-play are removed while
// casing is still intact (the patterns match natural text more reliably), then
// the server's casing and punctuation habits are imposed last.
function applyServerVoice(text, profile, { botName, wasTruncated = false } = {}) {
    if (typeof text !== 'string' || text.trim() === '') return '';

    let result = text.trim();
    result = stripSpeakerPrefix(result, botName);
    result = cutRolePlay(result);
    result = stripAssistantTics(result);
    result = trimDanglingSentence(result, wasTruncated);

    const style = profile?.style;
    result = matchCase(result, style);
    result = matchPunctuation(result, style);

    return result.replace(/\n{3,}/g, '\n\n').trim();
}

// Sampling parameters derived from the server rather than hardcoded. A server
// that writes one-liners gets a tight token budget, which does more for
// brevity than any amount of asking for it.
function samplingParamsFor(profile, overrides = {}) {
    const avgWords = profile?.style?.avgWords || 0;

    // ~1.4 tokens per word, with headroom so ordinary replies finish cleanly,
    // and a floor that still allows a real answer when someone asks for one.
    const budget = avgWords > 0 ? Math.round(avgWords * 1.4 * 6) : 0;
    const maxTokens = Math.min(500, Math.max(120, budget));

    return {
        // Warmer than default: the unexpected phrasing is the point, and the
        // dialect block keeps it anchored to real server language.
        temperature: 0.95,
        // Discourage the stock phrasing a model falls back on.
        presence_penalty: 0.3,
        frequency_penalty: 0.2,
        max_tokens: maxTokens,
        ...overrides,
    };
}

module.exports = {
    applyServerVoice,
    stripAssistantTics,
    stripSpeakerPrefix,
    cutRolePlay,
    matchCase,
    matchPunctuation,
    trimDanglingSentence,
    samplingParamsFor,
};
