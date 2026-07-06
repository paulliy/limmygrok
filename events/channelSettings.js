'use strict';

// Per-channel visibility settings (a helper module, not an event handler — it
// exports no `name`/`execute`, mirroring events/autoResponseState.js).
//
// `client.allowedChannels` is a channelId -> guildId store. It is an OPT-IN
// allowlist for AMBIENT auto-responses only: a channel must be added before the
// bot will auto-respond there. Direct @mentions are never gated by this.

function ensureStore(client) {
    if (!client.allowedChannels) {
        client.allowedChannels = new Map();
    }

    return client.allowedChannels;
}

function isChannelAllowed(client, channelId) {
    if (!channelId) return false;
    return ensureStore(client).has(channelId);
}

function allowChannel(client, channelId, guildId) {
    if (!channelId) {
        throw new Error('A channel ID is required to allow a channel.');
    }

    ensureStore(client).set(channelId, guildId ?? null);
    return channelId;
}

function disallowChannel(client, channelId) {
    if (!channelId) return false;
    return ensureStore(client).delete(channelId);
}

function listAllowedChannels(client, guildId) {
    const store = ensureStore(client);
    const channels = [];
    for (const [channelId, storedGuildId] of store.entries()) {
        // When a guildId is supplied, only return that guild's channels;
        // otherwise return everything.
        if (guildId === undefined || storedGuildId === guildId) {
            channels.push(channelId);
        }
    }

    return channels;
}

function clearAllowedChannels(client, guildId) {
    const store = ensureStore(client);
    const toRemove = listAllowedChannels(client, guildId);
    for (const channelId of toRemove) {
        store.delete(channelId);
    }

    return toRemove.length;
}

module.exports = {
    isChannelAllowed,
    allowChannel,
    disallowChannel,
    listAllowedChannels,
    clearAllowedChannels,
};
