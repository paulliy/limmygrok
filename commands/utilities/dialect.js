const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const {
    getStyleProfile,
    countMessages,
    forgetGuild,
} = require('../../utils/corpus');
const { describeStyle } = require('../../utils/prompt');
const { countMedia, forgetMedia } = require('../../utils/media');

// Makes the learning layer visible. Without this the bot's voice just drifts
// and nobody can tell whether it is picking things up, what it thinks the
// server's slang is, or how to make it stop.

function formatEntries(entries, format, empty) {
    if (!entries || entries.length === 0) return empty;
    return entries.map(format).join('\n');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dialect')
        .setDescription('See what the bot has learned from this server, or make it forget.')
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub.setName('show').setDescription('Show the slang, catchphrases and habits the bot picked up here.')
        )
        .addSubcommand((sub) =>
            sub.setName('refresh').setDescription('Recompute the learned profile right now instead of waiting.')
        )
        .addSubcommand((sub) =>
            sub.setName('forget').setDescription('Delete everything the bot has learned from this server. (Manage Server)')
        ),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: 'This command only works in a server.', flags: MessageFlags.Ephemeral });
            return;
        }

        const db = interaction.client.db;
        const guildId = interaction.guildId;
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'forget') {
            // Wiping the corpus throws away every message the bot has stored
            // for this server, so it is gated the same way /channels is.
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                await interaction.reply({
                    content: 'You need the **Manage Server** permission to wipe what the bot has learned.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const removed = forgetGuild(db, guildId);
            const removedMedia = forgetMedia(db, guildId);
            const parts = [];
            if (removed > 0) parts.push(`${removed.toLocaleString()} learned message${removed === 1 ? '' : 's'}`);
            if (removedMedia > 0) parts.push(`${removedMedia.toLocaleString()} saved gif${removedMedia === 1 ? '' : 's'}/image${removedMedia === 1 ? '' : 's'}`);

            await interaction.reply({
                content: parts.length === 0
                    ? 'There was nothing learned to forget.'
                    : `Forgot ${parts.join(' and ')}. The bot starts over from here.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const total = countMessages(db, guildId);
        if (total === 0) {
            await interaction.reply({
                content: 'I haven\'t learned anything here yet. Add a channel with `/channels add` and I\'ll start picking up how this server talks.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const profile = getStyleProfile(db, guildId, { force: subcommand === 'refresh' });
        if (!profile) {
            await interaction.reply({ content: 'Could not build a profile from what I have so far.', flags: MessageFlags.Ephemeral });
            return;
        }

        const vocabulary = formatEntries(
            profile.vocabulary?.slice(0, 15),
            (entry) => `\`${entry.term}\` ×${entry.count}`,
            '_nothing distinctive yet_'
        );
        const phrases = formatEntries(
            profile.phrases?.slice(0, 8),
            (entry) => `"${entry.term}" ×${entry.count}`,
            '_none yet_'
        );
        const emoji = [
            ...(profile.customEmoji || []).map((e) => e.term),
            ...(profile.unicodeEmoji || []).map((e) => e.term),
        ].slice(0, 10).join(' ') || '_none yet_';
        const habits = formatEntries(describeStyle(profile.style), (rule) => `• ${rule}`, '_still measuring_');

        const body = [
            `**What I've picked up here** — from ${total.toLocaleString()} messages (profiled on the most recent ${profile.sampleSize.toLocaleString()}).`,
            '',
            '**Server vocabulary**',
            vocabulary.split('\n').join(' · '),
            '',
            '**Catchphrases**',
            phrases,
            '',
            `**Emoji** ${emoji}`,
            '',
            '**Typing habits**',
            habits,
            '',
            `**Reaction gifs** ${countMedia(db, guildId).toLocaleString()} saved from this server, reused occasionally when the topic matches.`,
        ].join('\n');

        await interaction.reply({
            content: body.length > 1900 ? body.slice(0, 1900) + '…' : body,
            flags: MessageFlags.Ephemeral,
        });
    },
};
