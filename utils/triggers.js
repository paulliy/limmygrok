'use strict';

// When the bot should speak.
//
// Previously there were exactly two triggers: an explicit @mention, or the
// every-N-messages ambient counter. That misses the two most natural ways
// people actually address a bot in a running conversation — replying to
// something it said, and just using its name — which made it feel unresponsive
// in between and abrupt when the counter fired.
//
// Both MessageCreate listeners share these helpers so they keep dividing
// ownership cleanly: events/mention.js owns directly-addressed messages,
// events/messageStore.js owns everything else.

// Names the bot answers to beyond its own username. Configurable via
// BOT_ALIASES (comma-separated) for servers that nickname it.
function aliasesFor(client) {
    const configured = client?.config?.BOT_ALIASES || process.env.BOT_ALIASES || '';
    const fromConfig = String(configured)
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);

    const username = client?.user?.username?.toLowerCase();
    const names = new Set(fromConfig);
    if (username) names.add(username);
    return [...names];
}

// True when the message @mentions the bot. @everyone/@here deliberately do
// not count — a server-wide ping is not a question for the bot.
function isMentioned(message) {
    const botUser = message?.client?.user;
    if (!botUser) return false;
    if (message.mentions?.users?.has) {
        return message.mentions.users.has(botUser.id);
    }
    return Boolean(message.mentions?.has?.(botUser, { ignoreEveryone: true, ignoreRoles: true }));
}

// True when this message is a reply to something the bot said. Discord
// resolves the replied-to author into `mentions.repliedUser` even when the
// replying user turned the ping off, which is exactly the case we want to
// catch — a silent reply is still someone talking to the bot.
function isReplyToBot(message) {
    const botId = message?.client?.user?.id;
    if (!botId) return false;
    if (message.mentions?.repliedUser?.id === botId) return true;
    // Fallback for the cached-reference case where repliedUser is absent.
    const referenced = message.referencedMessage;
    return Boolean(referenced?.author?.id === botId);
}

// True when the bot's name appears as a whole word. Substring matching would
// fire on unrelated words that merely contain the name.
function mentionsBotName(message) {
    const content = String(message?.content || '').toLowerCase();
    if (!content) return false;

    return aliasesFor(message.client).some((name) => {
        if (!name || name.length < 3) return false;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(content);
    });
}

// The union: someone is talking *to* the bot rather than near it. These
// messages are handled by events/mention.js in any channel, allowlisted or
// not, and are skipped by events/messageStore.js.
function isDirectlyAddressed(message) {
    if (!message || message.author?.bot) return false;
    return isMentioned(message) || isReplyToBot(message) || mentionsBotName(message);
}

// Which of the triggers fired, for logging and stats.
function addressReason(message) {
    if (isMentioned(message)) return 'mention';
    if (isReplyToBot(message)) return 'reply';
    if (mentionsBotName(message)) return 'name';
    return null;
}

module.exports = {
    isMentioned,
    isReplyToBot,
    mentionsBotName,
    isDirectlyAddressed,
    addressReason,
    aliasesFor,
};
