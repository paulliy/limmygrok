const {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
    ChannelType,
} = require('discord.js');
const {
    allowChannel,
    disallowChannel,
    listAllowedChannels,
    clearAllowedChannels,
} = require('../../events/channelSettings');
const { backfillChannel } = require('../../utils/backfill');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('channels')
        .setDescription('Manage which channels the bot auto-responds in (@mentions always work).')
        // Gate to server admins in the Discord UI; also re-checked in execute().
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName('add')
                .setDescription('Enable auto-responses in a channel.')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The channel to enable (defaults to the current channel).')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('remove')
                .setDescription('Disable auto-responses in a channel.')
                .addChannelOption((option) =>
                    option
                        .setName('channel')
                        .setDescription('The channel to disable (defaults to the current channel).')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub.setName('list').setDescription('List the channels the bot auto-responds in.')
        )
        .addSubcommand((sub) =>
            sub.setName('clear').setDescription('Disable auto-responses in every channel of this server.')
        ),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
            return;
        }

        // Belt-and-suspenders: setDefaultMemberPermissions can be overridden by
        // server admins, so re-check the caller actually has Manage Server.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: 'You need the **Manage Server** permission to use this command.', flags: MessageFlags.Ephemeral });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        const client = interaction.client;
        const guildId = interaction.guildId;

        if (subcommand === 'add' || subcommand === 'remove') {
            const channel = interaction.options.getChannel('channel') ?? interaction.channel;
            if (!channel?.id) {
                await interaction.reply({ content: 'Could not resolve a channel to update.', flags: MessageFlags.Ephemeral });
                return;
            }

            if (subcommand === 'add') {
                allowChannel(client, channel.id, guildId);

                // Read the channel's existing history once so the bot has a
                // dialect immediately instead of after weeks of listening.
                // Deferred because fetching up to 1000 messages takes longer
                // than Discord's 3s interaction window.
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const learned = await backfillChannel(client, channel);
                await interaction.editReply({
                    content: learned > 0
                        ? `Auto-responses are now **enabled** in <#${channel.id}>, and I read back ${learned.toLocaleString()} messages to learn how this server talks. Try \`/dialect show\`.`
                        : `Auto-responses are now **enabled** in <#${channel.id}>.`,
                });
            } else {
                const removed = disallowChannel(client, channel.id);
                await interaction.reply({
                    content: removed
                        ? `Auto-responses are now **disabled** in <#${channel.id}>.`
                        : `<#${channel.id}> was not on the auto-response list.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            return;
        }

        if (subcommand === 'list') {
            const channelIds = listAllowedChannels(client, guildId);
            const content = channelIds.length === 0
                ? 'The bot does not auto-respond in any channel here yet. Use `/channels add` to enable one. (Direct @mentions always work.)'
                : `Auto-responses are enabled in: ${channelIds.map((id) => `<#${id}>`).join(', ')}`;
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
            return;
        }

        if (subcommand === 'clear') {
            const count = clearAllowedChannels(client, guildId);
            await interaction.reply({
                content: count === 0
                    ? 'There were no auto-response channels to clear.'
                    : `Cleared auto-responses in ${count} channel${count === 1 ? '' : 's'}.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
    },
};
