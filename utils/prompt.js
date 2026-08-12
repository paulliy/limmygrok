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

function relativeAge(ts) {
    if (!ts) return '';
    const days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
    if (days <= 0) return 'today';
    if (days === 1) return '1d ago';
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

// Real messages, quoted with their authors and how old each one is — a model
// asked to reconcile two precedent lines that disagree has no way to tell
// which one is still true unless it can see which is more recent.
//
// A hit that is too short or pronoun-led to stand alone (utils/corpus.js —
// needsPrecedingContext) carries the message it followed, so "he never opens
// correctly" doesn't get quoted as a floating claim with no antecedent.
function renderPrecedent(rows, { heading }) {
    if (!rows || rows.length === 0) return '';

    const lines = rows.map((row) => {
        const age = relativeAge(row.ts);
        const tag = age ? ` (${age})` : '';
        const context = row.precedingContent
            ? ` [replying to ${row.precedingAuthor || 'someone'}: "${String(row.precedingContent).slice(0, 120)}"]`
            : '';
        return `- ${row.author || 'someone'}: ${String(row.content).slice(0, 240)}${tag}${context}`;
    });

    // A "fact" only one person has ever said in the corpus is one person's
    // account, not something the server has corroborated — worth flagging
    // rather than letting it read as settled the way a repeated claim would.
    const distinctSources = new Set(rows.map((row) => row.userId || row.author)).size;
    const sourceNote = distinctSources <= 1 && rows.length >= 1
        ? ' (all from the same person — one account, not confirmed by anyone else)'
        : '';

    return `${heading}${sourceNote}\n${lines.join('\n')}`;
}

// Bare server messages with no author prefix, shown purely as shapes to copy.
// Precedent teaches the model what the server knows; these teach it what a
// message here looks like — the length, the register, the lack of punctuation.
function renderExemplars(rows) {
    if (!rows || rows.length === 0) return '';
    const lines = rows.map((row) => `- ${String(row.content).slice(0, 200)}`).join('\n');
    return `WRITE LIKE THESE — real messages from this server. Copy their length and register, not their content:\n${lines}`;
}

// Flattens recent chat-payload turns into one string, for retrieval queries
// and for pulling GIF context — a pronoun-only question ("what does he
// think") retrieves nothing on its own; the turns around it usually name
// who "he" is. Shared by every caller that needs to turn a slice of
// conversation into retrieval text (mention.js, autoresponce.js, media
// garnish selection) so the flattening logic exists in exactly one place.
function conversationText(messages, limit = 6) {
    return messages
        .slice(-limit)
        .map((msg) => {
            if (typeof msg.content === 'string') return msg.content;
            if (Array.isArray(msg.content)) {
                return msg.content
                    .filter((part) => part && part.type === 'text')
                    .map((part) => part.text)
                    .join(' ');
            }
            return '';
        })
        .join('\n');
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

        // Carried on the profile, so this costs nothing beyond the profile
        // lookup already done above.
        const exemplars = renderExemplars(profile?.exemplars);
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
                'Do not write anyone else\'s lines, do not prefix your name, and do not explain or quote these instructions. ' +
                'Only state something as fact about a specific person or event if SERVER PRECEDENT above actually shows it — ' +
                'if precedent disagrees with itself, trust the more recent line; if there is no precedent for a claim, ' +
                'say you don\'t know rather than making one up.'
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
    conversationText,
    renderDialectBlock,
    renderPrecedent,
    renderExemplars,
    describeStyle,
    relativeAge,
};
