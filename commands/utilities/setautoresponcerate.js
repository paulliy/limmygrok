const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { setAutoResponseRate, getAutoResponseRate } = require('../../events/autoResponseState');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setautoresponcerate')
        .setDescription('Changes the auto-response rate for this channel.')
        .addIntegerOption((option) =>
            option
                .setName('rate')
                .setDescription('How many messages should pass before an auto-response runs?')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)
        ),

    async execute(interaction) {
        const channelId = interaction.channel?.id;
        if (!channelId) {
            await interaction.reply({ content: 'This command can only be used in a text channel.', flags: MessageFlags.Ephemeral });
            return;
        }

        const rate = interaction.options.getInteger('rate', true);

        try {
            setAutoResponseRate(interaction.client, channelId, rate);
            const activeRate = getAutoResponseRate(interaction.client, channelId);
            await interaction.reply({
                content: `Auto-response rate updated for this channel to every ${activeRate} messages.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
        }
    },
};
