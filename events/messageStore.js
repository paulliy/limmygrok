const { Events } = require('discord.js');
const { generateAutoresponce } = require('./autoresponce');
const { getAutoResponseRate, resetAutoResponseCount } = require('../utils/autoResponseState');
const { isChannelAllowed } = require('../utils/channelSettings');
const { parseimgs } = require('../utils/parseimgs');
const { safeError, debugLog } = require('../utils/log');
const { isDirectlyAddressed } = require('../utils/triggers');
const { recordMessage } = require('../utils/corpus');
const { recordMedia } = require('../utils/media');
const { recordEvent } = require('../utils/stats');
const { readTurns, writeTurns } = require('../utils/memory');

// Memory entries hold either a plain string or an array of content parts;
// media context only needs the words.
function memoryEntryText(entry) {
    if (!entry) return '';
    if (typeof entry.content === 'string') return entry.content;
    if (Array.isArray(entry.content)) {
        return entry.content
            .filter((part) => part && part.type === 'text')
            .map((part) => part.text)
            .join(' ');
    }
    return '';
}

module.exports = {
    name: Events.MessageCreate,
    once: false,
    async execute(message) {
        // Don't store bot messages to avoid circularity/redundancy
        if (message.author.bot) return;

        // Messages addressed to the bot — @mention, a reply to it, or its name
        // — are owned entirely by events/mention.js: it stores the user turn,
        // feeds the corpus, and generates the reply. Skipping here avoids
        // double-processing regardless of listener order.
        if (isDirectlyAddressed(message)) return;

        const channelId = message.channel.id;

        // Ambient learning and auto-responses are opt-in per channel. Off the
        // allowlist the bot ignores the message entirely: nothing stored,
        // nothing learned, nothing counted. (Direct address bypasses this via
        // events/mention.js.)
        if (!isChannelAllowed(message.client, channelId)) return;

        const previousMemory = readTurns(message.client, channelId);

        // Add the current message. writeTurns applies the window cap.
        const parsed = parseimgs(message);
        const added = parsed.length > 0 ? [parsed[0]] : [];
        writeTurns(message.client, channelId, [...previousMemory, ...added]);

        // Feed the long-term corpus. Unlike `memory` (a 20-turn rolling window
        // used as conversation context) this is permanent and is what the
        // dialect profile and precedent retrieval are built from — the bot's
        // actual learning.
        if (message.guildId) {
            recordMessage(message.client.db, {
                guildId: message.guildId,
                channelId,
                userId: message.author.id,
                author: message.member?.displayName || message.author.displayName || message.author.username,
                content: message.content,
            });

            // GIFs and images are learned separately: a reaction GIF usually
            // arrives with no text of its own, so what it is reacting *to* is
            // the only thing that gives it a searchable meaning.
            recordMedia(message.client.db, {
                guildId: message.guildId,
                content: message.content,
                attachments: message.attachments,
                precedingText: memoryEntryText(previousMemory[previousMemory.length - 1]),
            });
        }

        recordEvent(message.client, 'message', {
            guildId: message.guildId,
            channelId,
            userId: message.author.id,
        });

        debugLog('[MEMORY]', JSON.stringify({ added }, null, 2));

        // Handle counter for auto-response
        let count = message.client.messageCounts.get(channelId) || 0;
        count++;
        message.client.messageCounts.set(channelId, count);

        const rate = getAutoResponseRate(message.client, channelId);
        if (count % rate === 0) {
            resetAutoResponseCount(message.client, channelId);
            try {
                await generateAutoresponce(message);
            } catch (error) {
                safeError('Auto-response generation failed:', error);
            }
        }
    }
};
