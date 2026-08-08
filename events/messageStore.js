const { Events } = require('discord.js');
const { generateAutoresponce } = require('./autoresponce');
const { getAutoResponseRate, resetAutoResponseCount } = require('./autoResponseState');
const { isChannelAllowed } = require('./channelSettings');
const { parseimgs } = require('../utils/parseimgs');
const { safeError, debugLog } = require('../utils/log');
const { isDirectlyAddressed } = require('../utils/triggers');
const { recordMessage } = require('../utils/corpus');
const { recordEvent } = require('../utils/stats');

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

        const previousMemory = message.client.memory.get(channelId) || [];
        let memory = previousMemory.slice();

        // Add the current message
        const parsed = parseimgs(message);
        const added = parsed.length > 0 ? [parsed[0]] : [];
        if (added.length > 0) {
            memory.push(...added);
        }

        // Keep only the last 20
        let removed = [];
        if (memory.length > 20) {
            removed = memory.slice(0, memory.length - 20);
            memory = memory.slice(-20);
        }

        message.client.memory.set(channelId, memory);

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
        }

        recordEvent(message.client, 'message', {
            guildId: message.guildId,
            channelId,
            userId: message.author.id,
        });

        debugLog('[MEMORY]', JSON.stringify({ added, removed }, null, 2));

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
