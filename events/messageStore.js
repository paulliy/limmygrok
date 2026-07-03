const { Events } = require('discord.js');
const { generateAutoresponce } = require('./autoresponce');
const { getAutoResponseRate, resetAutoResponseCount } = require('./autoResponseState');
const { parseimgs, safeLog, safeError } = require('../utils/parseimgs');

module.exports = {
    name: Events.MessageCreate,
    once: false,
    async execute(message) {
        // Don't store bot messages to avoid circularity/redundancy
        if (message.author.bot) return;

        const channelId = message.channel.id;
        let memory = message.client.memory.get(channelId) || [];

        // Add the current message
        const parsed = parseimgs(message);
        if (parsed.length > 0) {
            memory.push(parsed[0]);
        }

        // Keep only the last 20
        if (memory.length > 20) {
            memory = memory.slice(-20);
        }

        message.client.memory.set(channelId, memory);

        safeLog(`\n[DEBUG] Updated Memory:`, JSON.stringify(memory, null, 2));

        // Handle counter for auto-response
        let count = message.client.messageCounts.get(channelId) || 0;
        count++;
        message.client.messageCounts.set(channelId, count);

        const rate = getAutoResponseRate(message.client, channelId);
        if (count % rate === 0) {
            resetAutoResponseCount(message.client, channelId);
            await generateAutoresponce(message);
        }
    }
};