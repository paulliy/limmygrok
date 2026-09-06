'use strict';

const { safeError } = require('./log');

// Union of the two loadingPhrases lists that had diverged between
// mention.js and autoresponce.js.
const LOADING_PHRASES = [
    'Thinking', 'Pondering', 'Questing', 'Holding site',
    'Playing Valorant', 'Winning', 'Cooking', 'Strategizing',
    'Turtletiming', 'Coding', 'Synthizing', 'Baldliking',
    'Chudding', 'Meowling', 'Climbing rocks', 'Whiffing hard',
    'Bawberrying', 'Bankheading', 'Geneing', 'Limmying', 'Praying',
    'Five Stacking A', 'Dying mid', 'Eating Goldfish',
    'Saving the World', 'Plain Janing', 'Ai-ing', 'Listening to AJR',
    'Getting a new permit', 'Watching the sunset', 'Reading', 'Writing',
    'Exploring', 'Juggling', 'Solving', 'Aiming', 'Cleaning',
    'Painting', 'Dancing', 'Singing', 'Tinkering', 'Locking in',
    'Stargazing', 'Learning', 'Building', 'Sleeping', 'Flicking',
    'Waiting for tim', 'Scrolling', 'Watching cote', 'Holding mid',
    'Whiffing again', 'Full buying', 'Picking up the bomb', 'Defusing', 'Planting', 'Rotating',
    'Joining VC', 'Wordle streaking', 'Playing Smash', 'Creating Limmygrok', 'Deadlotting',
    'Queuing', 'Gooning', 'Mutting', 'Baiting', 'Boosting'
];

const DOT_FRAMES = ['.', ':', ': .', ': :', ': : .', ': : : .', ': : : :'];

// Discord's `ansi` code-block renderer only understands a limited SGR subset:
// styles 0 (reset)/1 (bold)/4 (underline), and fg colors 30-37. No "dim" (2).
// The phrase and the animated dots share one color (gray) so the whole loading
// line reads as a single muted unit.
const ANSI_RESET = '\x1b[0m';
const ANSI_GRAY = '\x1b[0;37m'; // white

function ansiFence(body) {
    return '```ansi\n' + body + '\n```';
}

function formatAnsiLoadingLine(phrase, dots) {
    return ansiFence(`${ANSI_GRAY}${phrase} ${dots}${ANSI_RESET}`);
}

function formatAnsiIdleText(text) {
    return ansiFence(`${ANSI_GRAY}${text}${ANSI_RESET}`);
}

const INITIAL_LOADING_TEXT = formatAnsiIdleText('Thinking...');

function stripThinkAndCitations(text, { partial = false } = {}) {
    const thinkPattern = partial
        ? /<think>(?:[\s\S]*?<\/think>|[\s\S]*$)/gi
        : /<think>[\s\S]*?<\/think>/gi;
    return (text || '').replace(thinkPattern, '').replace(/\[\d+\]/g, '').trim();
}

function truncateForDiscord(text, limit = 2000) {
    return text.length > limit ? text.slice(0, limit - 3) + '...' : text;
}

// Appends a GIF/image URL on its own line so Discord unfurls it into an embed.
// The text is truncated to leave room for the link rather than the other way
// round — a reply cut off mid-word with a dangling half-URL is worse than no
// GIF at all.
function withGarnish(text, url, limit = 2000) {
    if (!url) return truncateForDiscord(text, limit);
    const room = limit - url.length - 1;
    if (room < 1) return truncateForDiscord(text, limit);
    const body = truncateForDiscord(text, room);
    return body ? `${body}\n${url}` : url;
}

// Drives the shared "edit-in-place while streaming" UX used by mention.js,
// autoresponce.js, and gene.js: an interval decoupled from the stream itself
// (so Discord rate limits never block token reads) repaints either the
// accumulating content or an animated loading phrase, coalescing edits so
// identical repaints are skipped.
function createStreamAnimator({ edit, usePhrases = true, idleText = 'Thinking...', intervalMs = 1500 }) {
    let content = '';
    let lastDisplayed = null;
    let isEditing = false;
    let isFinished = false;
    let phraseIndex = Math.floor(Math.random() * LOADING_PHRASES.length);
    let frameIndex = 0;

    const interval = setInterval(async () => {
        if (isFinished) return;

        const displayContent = stripThinkAndCitations(content, { partial: true });

        let safeContent;
        if (displayContent) {
            safeContent = displayContent;
        } else if (usePhrases) {
            safeContent = formatAnsiLoadingLine(LOADING_PHRASES[phraseIndex], DOT_FRAMES[frameIndex]);
            frameIndex++;
            if (frameIndex >= DOT_FRAMES.length) {
                frameIndex = 0;
                phraseIndex = Math.floor(Math.random() * LOADING_PHRASES.length);
            }
        } else {
            safeContent = formatAnsiIdleText(idleText);
        }

        const chunk = truncateForDiscord(safeContent);
        if (isEditing || chunk === lastDisplayed) return;

        isEditing = true;
        try {
            await edit(chunk);
            lastDisplayed = chunk;
        } catch (error) {
            safeError('\n[DEBUG Edit Error]:', error.message);
        } finally {
            isEditing = false;
        }
    }, intervalMs);

    return {
        append(delta) {
            content += delta;
        },
        get content() {
            return content;
        },
        finish() {
            isFinished = true;
            clearInterval(interval);
        },
    };
}

module.exports = {
    LOADING_PHRASES,
    DOT_FRAMES,
    stripThinkAndCitations,
    truncateForDiscord,
    withGarnish,
    createStreamAnimator,
    formatAnsiLoadingLine,
    formatAnsiIdleText,
    INITIAL_LOADING_TEXT,
};
