'use strict';

// Learning a server's voice from scratch is slow if it only ever sees new
// messages: a quiet channel might take weeks to produce a useful dialect
// profile. Discord already holds the history, so when a channel is opted in
// the bot reads back through it once and learns immediately.
//
// This is what makes /channels add feel instant — the bot sounds like the
// server the moment it is switched on, rather than a fortnight later.

const { safeLog, safeError } = require('./log');
const { recordMessage } = require('./corpus');

const DISCORD_FETCH_PAGE = 100; // Discord's per-request maximum.
const DEFAULT_BACKFILL_LIMIT = 1000;

// Walks a channel's history newest-first, feeding every human message into the
// corpus. Returns how many were learned. Best-effort throughout: a permission
// error or a partial read still leaves the bot better off than before, so
// failures are logged and the count so far is returned.
async function backfillChannel(client, channel, { limit = DEFAULT_BACKFILL_LIMIT } = {}) {
    if (!client?.db || !channel?.messages?.fetch) return 0;

    const guildId = channel.guildId || channel.guild?.id;
    if (!guildId) return 0;

    let learned = 0;
    let before;

    try {
        while (learned < limit) {
            const pageSize = Math.min(DISCORD_FETCH_PAGE, limit - learned);
            const batch = await channel.messages.fetch({ limit: pageSize, ...(before ? { before } : {}) });
            if (!batch || batch.size === 0) break;

            for (const message of batch.values()) {
                before = message.id;
                if (message.author?.bot) continue;
                const recorded = recordMessage(client.db, {
                    guildId,
                    channelId: channel.id,
                    userId: message.author?.id,
                    author: message.member?.displayName || message.author?.displayName || message.author?.username,
                    content: message.content,
                    ts: message.createdTimestamp || Date.now(),
                });
                if (recorded) learned += 1;
            }

            // A short page means the channel history is exhausted.
            if (batch.size < pageSize) break;
        }
    } catch (error) {
        safeError(`[BACKFILL] Stopped early for channel ${channel.id}:`, error);
    }

    if (learned > 0) {
        safeLog(`[BACKFILL] Learned ${learned} messages from #${channel.name ?? channel.id}.`);
    }
    return learned;
}

module.exports = { backfillChannel, DEFAULT_BACKFILL_LIMIT };
