const { Events } = require('discord.js');
const { generateAutoresponce } = require('./autoresponce');
const { getAutoResponseRate, resetAutoResponseCount } = require('./autoResponseState');
const { isChannelAllowed } = require('./channelSettings');
const { parseimgs, safeLog, safeError } = require('../utils/parseimgs');
const { recordEvent } = require('../utils/stats');

module.exports = {
    name: Events.MessageCreate,
    once: false,
    async execute(message) {
        // Don't store bot messages to avoid circularity/redundancy
        if (message.author.bot) return;

        // Messages that mention the bot are owned entirely by events/mention.js:
        // it stores the (mention-stripped) user turn and generates the reply.
        // Skipping here avoids double-storing the same message regardless of the
        // order these two MessageCreate listeners run in.
        const isMentioned = message.mentions?.users
            ? message.mentions.users.has(message.client.user.id)
            : message.mentions?.has?.(message.client.user, { ignoreEveryone: true, ignoreRoles: true });
        if (isMentioned) return;

        const channelId = message.channel.id;

        // Ambient auto-responses are opt-in per channel. If this channel is not
        // on the allowlist, ignore the message entirely: no memory, no counting,
        // no auto-response. (Direct @mentions bypass this via events/mention.js.)
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

        recordEvent(message.client, 'message', {
            guildId: message.guildId,
            channelId,
            userId: message.author.id,
        });

        safeLog(`\n[DEBUG] Memory Update`, JSON.stringify({
            added,
            removed
        }, null, 2));

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