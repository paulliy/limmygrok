const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
    getAutoResponseRate,
    getMessagesUntilNextAutoResponse,
} = require('../../utils/autoResponseState');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('autoresponseinfo')
        .setDescription('Shows how many messages remain until the next auto-response in this channel.'),

    async execute(interaction) {
        const channelId = interaction.channel?.id;
        if (!channelId) {
            await interaction.reply({ content: 'This command can only be used in a text channel.', flags: MessageFlags.Ephemeral });
            return;
        }

        const rate = getAutoResponseRate(interaction.client, channelId);
        const remaining = getMessagesUntilNextAutoResponse(interaction.client, channelId);
        const currentCount = interaction.client.messageCounts?.get(channelId) || 0;

        await interaction.reply({
            content: `The next auto-response in this channel is due in ${remaining} message${remaining === 1 ? '' : 's'}. Current rate: every ${rate} messages. Current count: ${currentCount}.`,
            flags: MessageFlags.Ephemeral,
        });
    },
};
