// Tests for utils/db.js — SQLite-backed PersistentMap.
//
// The discriminating property under test: a value written through one
// PersistentMap is visible in a NEW PersistentMap constructed over the same
// database file (i.e. state survives a bot restart). A plain Map passes the
// in-process assertions but fails every reload assertion.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const realConsoleError = console.error;
beforeEach(() => { console.error = () => {}; });
afterEach(() => { console.error = realConsoleError; });

const { openDatabase, PersistentMap } = require('../utils/db');

function tempDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limmygrok-db-'));
    return path.join(dir, 'test.sqlite');
}

test('persistence: values written before a restart are loaded after it', () => {
    const file = tempDbPath();

    // "First run" of the bot
    const db1 = openDatabase(file);
    const memory1 = new PersistentMap(db1, 'memory');
    const counts1 = new PersistentMap(db1, 'messageCounts');
    const rates1 = new PersistentMap(db1, 'autoResponseRates');

    const history = [
        { role: 'user', content: 'hello bot' },
        { role: 'assistant', content: 'hello human' },
        { role: 'user', content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ] },
    ];
    memory1.set('ch-1', history);
    counts1.set('ch-1', 13);
    rates1.set('ch-1', 5);
    db1.close();

    // "Second run": fresh maps over the same file
    const db2 = openDatabase(file);
    const memory2 = new PersistentMap(db2, 'memory');
    const counts2 = new PersistentMap(db2, 'messageCounts');
    const rates2 = new PersistentMap(db2, 'autoResponseRates');

    assert.deepEqual(memory2.get('ch-1'), history, 'conversation memory should survive restart');
    assert.equal(counts2.get('ch-1'), 13, 'message counts should survive restart');
    assert.equal(rates2.get('ch-1'), 5, 'rate settings should survive restart');
    db2.close();
});

test('persistence: overwrites persist the latest value, not the first', () => {
    const file = tempDbPath();

    const db1 = openDatabase(file);
    const counts1 = new PersistentMap(db1, 'messageCounts');
    counts1.set('ch-1', 1);
    counts1.set('ch-1', 2);
    counts1.set('ch-1', 3);
    db1.close();

    const db2 = openDatabase(file);
    const counts2 = new PersistentMap(db2, 'messageCounts');
    assert.equal(counts2.get('ch-1'), 3);
    db2.close();
});

test('persistence: delete removes the row from disk too', () => {
    const file = tempDbPath();

    const db1 = openDatabase(file);
    const rates1 = new PersistentMap(db1, 'autoResponseRates');
    rates1.set('ch-1', 10);
    rates1.set('ch-2', 20);
    assert.equal(rates1.delete('ch-1'), true);
    assert.equal(rates1.delete('ch-missing'), false);
    db1.close();

    const db2 = openDatabase(file);
    const rates2 = new PersistentMap(db2, 'autoResponseRates');
    assert.equal(rates2.has('ch-1'), false, 'deleted key must not come back after restart');
    assert.equal(rates2.get('ch-2'), 20, 'other keys are untouched');
    db2.close();
});

test('persistence: stores are isolated from each other in the shared table', () => {
    const file = tempDbPath();

    const db1 = openDatabase(file);
    new PersistentMap(db1, 'memory').set('ch-1', [{ role: 'user', content: 'hi' }]);
    new PersistentMap(db1, 'messageCounts').set('ch-1', 7);
    db1.close();

    const db2 = openDatabase(file);
    const memory2 = new PersistentMap(db2, 'memory');
    const counts2 = new PersistentMap(db2, 'messageCounts');
    assert.deepEqual(memory2.get('ch-1'), [{ role: 'user', content: 'hi' }]);
    assert.equal(counts2.get('ch-1'), 7, 'same key in a different store must not collide');
    db2.close();
});

test('persistence: a corrupt row is skipped without breaking the rest of the store', () => {
    const file = tempDbPath();

    const db1 = openDatabase(file);
    const memory1 = new PersistentMap(db1, 'memory');
    memory1.set('ch-good', [{ role: 'user', content: 'fine' }]);
    // Sabotage one row directly (simulates partial corruption / bad migration).
    db1.prepare('INSERT INTO kv_store (store, key, value) VALUES (?, ?, ?)')
        .run('memory', 'ch-bad', '{not valid json');
    db1.close();

    const db2 = openDatabase(file);
    const memory2 = new PersistentMap(db2, 'memory');
    assert.equal(memory2.has('ch-bad'), false, 'corrupt row is dropped');
    assert.deepEqual(memory2.get('ch-good'), [{ role: 'user', content: 'fine' }], 'healthy rows still load');
    db2.close();
});
