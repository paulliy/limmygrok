// Tests for the two small shared modules extracted while de-duplicating the
// reply paths: the conversation window (utils/memory.js) and the prepared
// statement cache (utils/sql.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MEMORY_LIMIT, readTurns, writeTurns, appendTurn } = require('../utils/memory');
const { prepareCached } = require('../utils/sql');
const { openDatabase } = require('../utils/db');

function mockClient() {
    return { memory: new Map() };
}

// --- conversation window -----------------------------------------------------

test('readTurns is empty for an unseen channel and never throws', () => {
    assert.deepEqual(readTurns(mockClient(), 'ch-1'), []);
    assert.deepEqual(readTurns({}, 'ch-1'), []);
});

test('appendTurn adds to the window', () => {
    const client = mockClient();
    appendTurn(client, 'ch-1', { role: 'user', content: 'first' });
    appendTurn(client, 'ch-1', { role: 'assistant', content: 'second' });

    assert.deepEqual(readTurns(client, 'ch-1').map((t) => t.content), ['first', 'second']);
});

test('the window is capped, keeping the most recent turns', () => {
    const client = mockClient();
    for (let i = 0; i < MEMORY_LIMIT + 5; i++) {
        appendTurn(client, 'ch-1', { role: 'user', content: `msg-${i}` });
    }

    const turns = readTurns(client, 'ch-1');
    assert.equal(turns.length, MEMORY_LIMIT);
    assert.equal(turns[turns.length - 1].content, `msg-${MEMORY_LIMIT + 4}`);
    assert.equal(turns[0].content, 'msg-5', 'the oldest turns are the ones dropped');
});

test('channels keep separate windows', () => {
    const client = mockClient();
    appendTurn(client, 'ch-1', { role: 'user', content: 'a' });
    appendTurn(client, 'ch-2', { role: 'user', content: 'b' });

    assert.deepEqual(readTurns(client, 'ch-1').map((t) => t.content), ['a']);
    assert.deepEqual(readTurns(client, 'ch-2').map((t) => t.content), ['b']);
});

test('writeTurns always goes through .set(), which is what persists', () => {
    // client.memory is a PersistentMap in production: it write-throughs to
    // SQLite on .set() and only on .set(). Mutating the stored array in place
    // would be lost on restart, so this asserts the call actually happens.
    const sets = [];
    const client = { memory: { get: () => [], set: (k, v) => sets.push([k, v]) } };

    writeTurns(client, 'ch-1', [{ role: 'user', content: 'x' }]);
    assert.equal(sets.length, 1);
    assert.equal(sets[0][0], 'ch-1');
    assert.equal(sets[0][1][0].content, 'x');
});

// --- prepared statement cache ------------------------------------------------

function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limmygrok-sql-'));
    return openDatabase(path.join(dir, 'test.sqlite'));
}

test('the same SQL returns the same prepared statement', () => {
    const db = tempDb();
    const sql = 'SELECT COUNT(*) AS n FROM corpus_messages WHERE guild_id = ?';

    assert.equal(prepareCached(db, sql), prepareCached(db, sql));
    assert.notEqual(prepareCached(db, sql), prepareCached(db, 'SELECT 1'));
    db.close();
});

test('cached statements still execute correctly', () => {
    const db = tempDb();
    const insert = prepareCached(db, 'INSERT INTO corpus_messages (guild_id, channel_id, content, ts) VALUES (?, ?, ?, ?)');
    insert.run('g1', 'c1', 'bawberry holding site', Date.now());
    insert.run('g1', 'c1', 'deadlotting again', Date.now());

    const count = prepareCached(db, 'SELECT COUNT(*) AS n FROM corpus_messages WHERE guild_id = ?').get('g1');
    assert.equal(count.n, 2, 'a reused statement must still bind fresh parameters');
    db.close();
});

test('each database gets its own statement cache', () => {
    const a = tempDb();
    const b = tempDb();
    const sql = 'SELECT COUNT(*) AS n FROM corpus_messages';

    // Sharing a statement across handles would bind against the wrong
    // database; the cache is keyed by handle to prevent it.
    assert.notEqual(prepareCached(a, sql), prepareCached(b, sql));
    a.close();
    b.close();
});
