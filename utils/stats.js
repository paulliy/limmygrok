'use strict';

// Write-side of the usage log consumed by dashboard/. Best-effort: a logging
// failure must never break the bot, so every insert is wrapped and swallowed
// (mirroring PersistentMap's persistence error handling in utils/db.js).

const { safeError } = require('./parseimgs');

function recordEvent(client, type, meta = {}) {
    if (!client?.db) return;
    try {
        client.db
            .prepare(
                'INSERT INTO stats_events (type, name, guild_id, channel_id, user_id, ts) VALUES (?, ?, ?, ?, ?, ?)'
            )
            .run(
                type,
                meta.name ?? null,
                meta.guildId ?? null,
                meta.channelId ?? null,
                meta.userId ?? null,
                Date.now()
            );
    } catch (e) {
        safeError(`[STATS] Failed to record "${type}" event:`, e);
    }
}

module.exports = { recordEvent };
