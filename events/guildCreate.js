const { Events, PermissionFlagsBits, ChannelType } = require('discord.js');
const { safeLog, safeError } = require('../utils/parseimgs');

const ONBOARDING_MESSAGE =
    '👋 Thanks for adding me!\n\n' +
    'By default I stay quiet in every channel. To let me **auto-respond** in a channel, ' +
    'an admin (Manage Server) should run:\n' +
    '`/channels add #channel`\n\n' +
    'Other commands: `/channels list`, `/channels remove`, `/channels clear`.\n' +
    'You can also just **@mention me** in any channel and I\'ll reply — that always works.';

// Find a text channel the bot can actually post in, preferring the guild's
// system channel.
function findPostableChannel(guild) {
    const me = guild.members.me;
    if (!me) return null;

    const canPost = (channel) =>
        channel &&
        channel.type === ChannelType.GuildText &&
        channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) &&
        channel.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel);

    if (canPost(guild.systemChannel)) {
        return guild.systemChannel;
    }

    return guild.channels.cache.find(canPost) ?? null;
}

module.exports = {
    name: Events.GuildCreate,
    once: false,
    async execute(guild) {
        // Never let onboarding throw out of the handler — it's best-effort.
        try {
            const channel = findPostableChannel(guild);
            if (channel) {
                await channel.send(ONBOARDING_MESSAGE);
                safeLog(`[GUILD JOIN] Sent onboarding message in ${guild.name} (#${channel.name}).`);
                return;
            }

            // No postable channel — fall back to DMing the owner.
            const owner = await guild.fetchOwner();
            await owner.send(
                `Thanks for adding me to **${guild.name}**! I couldn't find a channel I can post in, so:\n\n${ONBOARDING_MESSAGE}`
            );
            safeLog(`[GUILD JOIN] DMed owner of ${guild.name} (no postable channel).`);
        } catch (error) {
            safeError(`[GUILD JOIN] Could not deliver onboarding message for ${guild?.name}:`, error);
        }
    },
};
