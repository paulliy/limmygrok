const { Events } = require('discord.js');
const { generateAutoresponce } = require('./autoresponce');
const { getAutoResponseRate, resetAutoResponseCount } = require('./autoResponseState');

module.exports = {
    name: Events.MessageCreate,
    once: false,
    async execute(message) {
        // Don't store bot messages to avoid circularity/redundancy
        if (message.author.bot) return;

        const channelId = message.channel.id;
        let memory = message.client.memory.get(channelId) || [];

        // Add the current message
        memory.push({
            role: 'user',
            content: message.content
        });

        // Keep only the last 20
        if (memory.length > 20) {
            memory = memory.slice(-20);
        }

        message.client.memory.set(channelId, memory);

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