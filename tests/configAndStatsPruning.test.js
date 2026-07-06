// Tests for utils/config.js (fail-fast config validation) and the
// stats_events retention pruning in utils/stats.js.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const realConsoleError = console.error;
beforeEach(() => { console.error = () => {}; });
afterEach(() => { console.error = realConsoleError; });

const { missingConfigKeys, assertRequiredConfig } = require('../utils/config');
const { openDatabase } = require('../utils/db');
const { recordEvent, pruneStatsEvents, STATS_RETENTION_DAYS } = require('../utils/stats');

function tempDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limmygrok-stats-'));
    return path.join(dir, 'test.sqlite');
}

// --- config validation -------------------------------------------------------

test('config: all required keys present passes', () => {
    const config = { token: 't', APIkey: 'k', API_BASE_URL: 'http://x', MODEL_NAME: 'm' };
    assert.deepEqual(missingConfigKeys(config, ['token', 'APIkey', 'API_BASE_URL', 'MODEL_NAME']), []);
    assert.doesNotThrow(() => assertRequiredConfig(config, ['token', 'APIkey']));
});

test('config: missing, null, and blank-string keys are all reported', () => {
    const config = { token: 'ok', APIkey: null, API_BASE_URL: '   ' }; // MODEL_NAME absent
    const missing = missingConfigKeys(config, ['token', 'APIkey', 'API_BASE_URL', 'MODEL_NAME']);
    assert.deepEqual(missing, ['APIkey', 'API_BASE_URL', 'MODEL_NAME']);
});

test('config: assertRequiredConfig throws one message listing every missing key', () => {
    assert.throws(
        () => assertRequiredConfig({ token: 't' }, ['token', 'clientId', 'guildId']),
        /missing required key\(s\): clientId, guildId/
    );
});

test('config: non-object config treats every key as missing', () => {
    assert.deepEqual(missingConfigKeys(undefined, ['token', 'APIkey']), ['token', 'APIkey']);
    assert.throws(() => assertRequiredConfig(null, ['token']), /token/);
});

// --- stats pruning -----------------------------------------------------------

test('stats pruning: removes rows older than the retention window, keeps fresh ones', () => {
    const db = openDatabase(tempDbPath());
    const client = { db };

    // One fresh row via the public API...
    recordEvent(client, 'message', { channelId: 'ch-1' });
    // ...and one row aged past the retention window, inserted directly.
    const oldTs = Date.now() - (STATS_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    db.prepare(
        'INSERT INTO stats_events (type, name, guild_id, channel_id, user_id, ts) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('message', null, null, 'ch-old', null, oldTs);

    const removed = pruneStatsEvents(db);
    assert.equal(removed, 1);

    const remaining = db.prepare('SELECT channel_id FROM stats_events').all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].channel_id, 'ch-1');
    db.close();
});

test('stats pruning: respects a custom maxAgeDays', () => {
    const db = openDatabase(tempDbPath());
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    db.prepare(
        'INSERT INTO stats_events (type, ts) VALUES (?, ?)'
    ).run('message', twoDaysAgo);

    // 3-day window keeps it; 1-day window removes it.
    assert.equal(pruneStatsEvents(db, 3), 0);
    assert.equal(pruneStatsEvents(db, 1), 1);
    db.close();
});

test('stats pruning: best-effort — a broken db returns 0 instead of throwing', () => {
    assert.equal(pruneStatsEvents(null), 0);
    const brokenDb = { prepare: () => { throw new Error('db is closed'); } };
    assert.equal(pruneStatsEvents(brokenDb), 0);
});
