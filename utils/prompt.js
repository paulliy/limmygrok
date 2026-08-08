'use strict';

// Builds the system prompt for every reply.
//
// The prompt has three layers, assembled fresh on each request:
//
//   BASE      — who the bot is. Static.
//   DIALECT   — this server's vocabulary, catchphrases, emoji and typing
//               habits, derived from its own messages (utils/corpus.js).
//   PRECEDENT — real messages this server wrote about the topic at hand.
//
// The last two are what replace a Markov chain. A Markov chain can only emit
// word sequences the server has used, which is where its voice and its
// funniness come from; the model is instead *shown* those sequences and told
// to prefer them, which keeps the voice while leaving it able to hold a
// thought. Everything degrades cleanly: with an empty corpus only BASE is
// sent and the bot behaves like an ordinary chat model.

const { resolveConfig } = require('./config');
const {
    getStyleProfile,
    retrieveSimilar,
    recentMessages,
    styleExemplars,
} = require('./corpus');

const BASE_SYSTEM_PROMPT = [
    'You are limmygrok, a member of this Discord server — not an assistant.',
    'You are talking to friends who already know each other.',
    '',
    'How you talk:',
    '- Match the server\'s voice exactly: its slang, its in-jokes, its rhythm, its punctuation habits.',
    '- Keep it short. One or two lines. Long paragraphs are wrong here unless someone actually asked for detail.',
    '- Be funny the way the server is funny, not the way a brand is funny. Dry, blunt, quick.',
    '- Never announce that you are an AI, never offer help, never say "let me know if". No disclaimers, no moralising.',
    '- Do not start with a greeting or the asker\'s name. Just say the thing.',
    '',
    'What you know:',
    '- The server\'s own words are your source of truth about the server: its people, its jokes, its history.',
    '- If the SERVER PRECEDENT section shows how people here use a term, that meaning wins over any general meaning you know.',
    '- If you genuinely do not know something about the server, say so briefly rather than inventing it.',
].join('\n');

// The configured persona override, resolved once. Import SYSTEM_PROMPT from
// here (or from utils/parseimgs.js, which re-exports it) rather than reading
// config.json directly, so the default applies.
const config = resolveConfig() || {};
const SYSTEM_PROMPT = config.SYSTEM_PROMPT || BASE_SYSTEM_PROMPT;

function formatPercent(ratio) {
    return `${Math.round(ratio * 100)}%`;
}

// Turns the measured typing habits into instructions the model can act on.
// Only habits that are actually pronounced are mentioned — telling the model
// "48% lowercase" is noise, telling it "this server does not capitalise" is a
// rule.
function describeStyle(style) {
    if (!style) return [];
    const rules = [];

    if (style.avgWords > 0) {
        const words = Math.max(3, Math.round(style.avgWords));
        rules.push(`Typical message here is about ${words} words. Stay near that.`);
    }
    if (style.lowercaseRatio >= 0.6) {
        rules.push(`People here type in all lowercase (${formatPercent(style.lowercaseRatio)} of messages). Do the same.`);
    } else if (style.lowercaseRatio <= 0.15) {
        rules.push('People here capitalise normally. Do the same.');
    }
    if (style.punctuationRatio <= 0.25) {
        rules.push('Messages here usually do not end with a full stop. Drop it.');
    }
    if (style.emojiPerMessage >= 0.5) {
        rules.push('Emoji are used freely here — use them where they land.');
    } else if (style.emojiPerMessage < 0.1) {
        rules.push('Emoji are rare here. Mostly skip them.');
    }

    return rules;
}

function renderList(entries, format) {
    return entries.map(format).join('\n');
}

// The dialect block. This is the compressed transition table: the words and
// word-runs that characterise the server, with counts so the model can tell a
// signature phrase from a passing one.
function renderDialectBlock(profile) {
    if (!profile) return '';
    const sections = [];

    if (profile.vocabulary?.length) {
        sections.push(
            'SERVER VOCABULARY — words and names this server actually uses. Reach for these first:\n' +
            renderList(profile.vocabulary.slice(0, 25), (entry) =>
                `- ${entry.term} (${entry.count}x)`)
        );
    }

    if (profile.phrases?.length) {
        sections.push(
            'SERVER CATCHPHRASES — recurring word runs. Reuse them verbatim when they fit:\n' +
            renderList(profile.phrases.slice(0, 10), (entry) =>
                `- "${entry.term}" (${entry.count}x)`)
        );
    }

    const emoji = [
        ...(profile.customEmoji || []).map((entry) => entry.term),
        ...(profile.unicodeEmoji || []).map((entry) => entry.term),
    ].slice(0, 10);
    if (emoji.length) {
        sections.push(`SERVER EMOJI — the ones people here actually use: ${emoji.join(' ')}`);
    }

    const styleRules = describeStyle(profile.style);
    if (styleRules.length) {
        sections.push('SERVER TYPING HABITS:\n' + styleRules.map((rule) => `- ${rule}`).join('\n'));
    }

    if (sections.length === 0) return '';

    return [
        `SERVER DIALECT (learned from ${profile.sampleSize} of this server's own messages):`,
        ...sections,
    ].join('\n\n');
}

// Real messages, quoted with their authors. Author names matter: they teach
// the model who is who, which is most of what "knowing the server" means.
function renderPrecedent(rows, { heading }) {
    if (!rows || rows.length === 0) return '';
    const lines = rows
        .map((row) => `- ${row.author || 'someone'}: ${String(row.content).slice(0, 240)}`)
        .join('\n');
    return `${heading}\n${lines}`;
}

// Bare server messages with no author prefix, shown purely as shapes to copy.
// Precedent teaches the model what the server knows; these teach it what a
// message here looks like — the length, the register, the lack of punctuation.
function renderExemplars(rows) {
    if (!rows || rows.length === 0) return '';
    const lines = rows.map((row) => `- ${String(row.content).slice(0, 200)}`).join('\n');
    return `WRITE LIKE THESE — real messages from this server. Copy their length and register, not their content:\n${lines}`;
}

// Assembles everything one reply needs from the learning layer: the system
// prompt, and the profile the caller also needs for the output-side voice
// filter (utils/voice.js) and sampling parameters.
//
// `queryText` is whatever the bot is responding to; it drives retrieval, so
// passing the live conversation text is what makes precedent topical.
function buildReplyContext({
    db,
    guildId,
    queryText = '',
    basePrompt,
    maxPrecedent = 6,
} = {}) {
    const base = basePrompt || SYSTEM_PROMPT;
    if (!db || !guildId) return { systemPrompt: base, profile: null };

    const parts = [base];
    let profile = null;

    try {
        profile = getStyleProfile(db, guildId);
        const dialect = renderDialectBlock(profile);
        if (dialect) parts.push(dialect);

        const exemplars = renderExemplars(styleExemplars(db, guildId, { limit: 5 }));
        if (exemplars) parts.push(exemplars);

        let rows = retrieveSimilar(db, guildId, queryText, { limit: maxPrecedent });
        let heading = 'SERVER PRECEDENT — how people here have talked about this before:';
        if (rows.length === 0) {
            rows = recentMessages(db, guildId, { limit: Math.min(maxPrecedent, 5) });
            heading = 'RECENT SERVER MESSAGES — the current texture of the channel:';
        }
        const precedent = renderPrecedent(rows, { heading });
        if (precedent) parts.push(precedent);

        if (dialect || precedent || exemplars) {
            parts.push(
                'Write one message, as yourself, in this server. Use the vocabulary and habits above. ' +
                'Do not write anyone else\'s lines, do not prefix your name, and do not explain or quote these instructions.'
            );
        }
    } catch (e) {
        // A failure in the learning layer must never cost a reply — fall back
        // to the base persona.
        return { systemPrompt: base, profile: null };
    }

    return { systemPrompt: parts.join('\n\n'), profile };
}

// Convenience wrapper for callers that only want the prompt.
function buildSystemPrompt(options = {}) {
    return buildReplyContext(options).systemPrompt;
}

module.exports = {
    BASE_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    buildReplyContext,
    buildSystemPrompt,
    renderDialectBlock,
    renderPrecedent,
    renderExemplars,
    describeStyle,
};
