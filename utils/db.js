'use strict';

// SQLite-backed persistence (bun:sqlite, built into Bun — no extra dependency).
//
// All bot state lives in client-level Maps (memory, messageCounts,
// autoResponseRates) and every handler already talks to them through
// .get()/.set()/.delete(). PersistentMap keeps that exact interface but
// write-through mirrors each mutation to SQLite, and reloads the store on
// construction — so state survives restarts with no changes to the
// events/commands code.

const { Database } = require('bun:sqlite');
const { safeError } = require('./log');
const { initCorpusSchema } = require('./corpus');
const { initMediaSchema } = require('./media');

function openDatabase(filePath) {
    const db = new Database(filePath, { create: true });
    // WAL keeps the frequent small writes (one per message) fast and crash-safe.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`
        CREATE TABLE IF NOT EXISTS kv_store (
            store TEXT NOT NULL,
            key   TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (store, key)
        );
    `);
    // Append-only usage log (commands run, messages seen, auto-responses/mentions
    // sent). Read by the local dashboard (dashboard/) to chart usage over time;
    // nothing else in the bot queries it.
    db.exec(`
        CREATE TABLE IF NOT EXISTS stats_events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            type       TEXT NOT NULL,
            name       TEXT,
            guild_id   TEXT,
            channel_id TEXT,
            user_id    TEXT,
            ts         INTEGER NOT NULL
        );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_stats_events_type_ts ON stats_events (type, ts);');

    // The learned server corpus + its FTS index and cached dialect profiles.
    // Defined in utils/corpus.js so the learning layer owns its own schema.
    initCorpusSchema(db);
    // The server's reusable GIFs/images, learned the same way.
    initMediaSchema(db);

    return db;
}

class PersistentMap extends Map {
    constructor(db, storeName) {
        super();
        this._store = storeName;
        this._upsert = db.prepare(
            'INSERT INTO kv_store (store, key, value) VALUES (?, ?, ?) ' +
            'ON CONFLICT(store, key) DO UPDATE SET value = excluded.value'
        );
        this._remove = db.prepare('DELETE FROM kv_store WHERE store = ? AND key = ?');
        this._removeAll = db.prepare('DELETE FROM kv_store WHERE store = ?');

        // Hydrate from disk. super.set avoids re-writing what was just read.
        const rows = db.prepare('SELECT key, value FROM kv_store WHERE store = ?').all(storeName);
        for (const row of rows) {
            try {
                super.set(row.key, JSON.parse(row.value));
            } catch (e) {
                safeError(`[DB] Skipping corrupt row in "${storeName}" for key ${row.key}:`, e);
            }
        }
    }

    set(key, value) {
        super.set(key, value);
        try {
            this._upsert.run(this._store, String(key), JSON.stringify(value));
        } catch (e) {
            // Persistence failure must never break the live bot; the in-memory
            // value is still current, we just lose it on the next restart.
            safeError(`[DB] Failed to persist "${this._store}" key ${key}:`, e);
        }
        return this;
    }

    delete(key) {
        const had = super.delete(key);
        if (had) {
            try {
                this._remove.run(this._store, String(key));
            } catch (e) {
                safeError(`[DB] Failed to delete "${this._store}" key ${key}:`, e);
            }
        }
        return had;
    }

    clear() {
        super.clear();
        try {
            this._removeAll.run(this._store);
        } catch (e) {
            safeError(`[DB] Failed to clear "${this._store}":`, e);
        }
    }
}

module.exports = { openDatabase, PersistentMap };
