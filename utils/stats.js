'use strict';

// Write-side of the usage log consumed by dashboard/. Best-effort: a logging
// failure must never break the bot, so every insert is wrapped and swallowed
// (mirroring PersistentMap's persistence error handling in utils/db.js).

const { safeError } = require('./log');

const insertStatements = new WeakMap();

function recordEvent(client, type, meta = {}) {
    if (!client?.db) return;
    try {
        let stmt = insertStatements.get(client.db);
        if (!stmt) {
            stmt = client.db.prepare(
                'INSERT INTO stats_events (type, name, guild_id, channel_id, user_id, ts) VALUES (?, ?, ?, ?, ?, ?)'
            );
            insertStatements.set(client.db, stmt);
        }
        stmt.run(
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

const STATS_RETENTION_DAYS = 90;

// The usage log is append-only (one row per message/command/response) and
// nothing in the bot reads it back, so without pruning it grows forever.
// Called at startup and once a day from index.js; best-effort like the rest
// of this module.
function pruneStatsEvents(db, maxAgeDays = STATS_RETENTION_DAYS) {
    if (!db) return 0;
    try {
        const cutoffTs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        const result = db.prepare('DELETE FROM stats_events WHERE ts < ?').run(cutoffTs);
        return result?.changes ?? 0;
    } catch (e) {
        safeError('[STATS] Failed to prune old stats events:', e);
        return 0;
    }
}

module.exports = { recordEvent, pruneStatsEvents, STATS_RETENTION_DAYS };
