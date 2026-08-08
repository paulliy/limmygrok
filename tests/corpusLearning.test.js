// Tests for the learning layer: corpus writes, the derived dialect profile,
// full-text precedent retrieval, and the prompt assembled from both.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../utils/db');
const {
    recordMessage,
    getStyleProfile,
    computeStyleProfile,
    retrieveSimilar,
    recentMessages,
    buildMatchQuery,
    countMessages,
    forgetGuild,
    pruneCorpus,
    tokenize,
    isLearnable,
    normalizeForLearning,
} = require('../utils/corpus');
const { buildSystemPrompt, renderDialectBlock, describeStyle, BASE_SYSTEM_PROMPT } = require('../utils/prompt');

function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limmygrok-corpus-'));
    return openDatabase(path.join(dir, 'test.sqlite'));
}

function seed(db, messages, { guildId = 'g1', channelId = 'c1' } = {}) {
    let ts = Date.now() - messages.length * 1000;
    for (const [userId, content] of messages) {
        recordMessage(db, { guildId, channelId, userId, author: userId, content, ts: (ts += 1000) });
    }
}

// --- text handling -----------------------------------------------------------

test('normalizeForLearning strips code, links and raw mention IDs', () => {
    const cleaned = normalizeForLearning('hey <@1234> look https://example.com/x `code` bawberry');
    assert.equal(cleaned.includes('<@1234>'), false);
    assert.equal(cleaned.includes('example.com'), false);
    assert.equal(cleaned.includes('code'), false);
    assert.equal(cleaned.includes('bawberry'), true);
});

test('tokenize lowercases and keeps custom emoji names as words', () => {
    assert.deepEqual(tokenize('Holding SITE <:limmy:123>'), ['holding', 'site', 'limmy']);
});

test('isLearnable rejects bare links, commands and stubs but keeps real chat', () => {
    assert.equal(isLearnable('https://example.com'), false);
    assert.equal(isLearnable('/dialect show'), false);
    assert.equal(isLearnable('ok'), false);
    assert.equal(isLearnable('bawberry is holding site again'), true);
});

// --- corpus writes -----------------------------------------------------------

test('recordMessage persists learnable messages and skips the rest', () => {
    const db = tempDb();
    assert.equal(recordMessage(db, { guildId: 'g1', channelId: 'c1', content: 'holding site with bawberry' }), true);
    assert.equal(recordMessage(db, { guildId: 'g1', channelId: 'c1', content: 'https://example.com' }), false);
    assert.equal(countMessages(db, 'g1'), 1);
    assert.equal(countMessages(db, 'other-guild'), 0);
    db.close();
});

test('corpus is scoped per guild and forgetGuild wipes only that guild', () => {
    const db = tempDb();
    seed(db, [['u1', 'bawberry whiffed mid again']], { guildId: 'g1' });
    seed(db, [['u2', 'completely different server words']], { guildId: 'g2' });

    assert.equal(forgetGuild(db, 'g1'), 1);
    assert.equal(countMessages(db, 'g1'), 0);
    assert.equal(countMessages(db, 'g2'), 1);
    db.close();
});

// Regression guard. Bun's `stmt.run().changes` is a delta of SQLite's
// total_changes(), not sqlite3_changes(), so it counts rows written by
// triggers too. corpus_messages has FTS sync triggers, and each delete causes
// several shadow-table writes — deleting 1 message reports 7, deleting 5
// reports 19. Both counts below are shown to users by /dialect forget, so they
// are measured with COUNT(*) instead. If someone "simplifies" either back to
// result.changes, this fails.
test('deletion counts are real message counts, not the driver changes tally', () => {
    const db = tempDb();
    seed(db, Array.from({ length: 5 }, (_, i) => ['u1', `bawberry holding site number ${i}`]));

    // Prove the driver really does over-report on this table, so the reason
    // for the workaround is visible rather than folklore.
    const raw = db.prepare('DELETE FROM corpus_messages WHERE guild_id = ? AND content LIKE ?')
        .run('g1', '%number 0%');
    assert.equal(raw.changes > 1, true, 'expected the FTS triggers to inflate .changes');

    assert.equal(countMessages(db, 'g1'), 4);
    assert.equal(forgetGuild(db, 'g1'), 4, 'forgetGuild must report messages, not row-writes');
    assert.equal(countMessages(db, 'g1'), 0);
    db.close();
});

test('pruneCorpus reports how many messages it actually dropped', () => {
    const db = tempDb();
    seed(db, Array.from({ length: 10 }, (_, i) => ['u1', `bawberry holding site number ${i}`]));
    assert.equal(pruneCorpus(db, 'g1', 4), 6);
    assert.equal(pruneCorpus(db, 'g1', 4), 0, 'nothing to do when already under the cap');
    db.close();
});

test('pruneCorpus keeps only the newest messages', () => {
    const db = tempDb();
    seed(db, Array.from({ length: 10 }, (_, i) => ['u1', `bawberry message number ${i}`]));
    assert.equal(countMessages(db, 'g1'), 10);

    pruneCorpus(db, 'g1', 4);
    assert.equal(countMessages(db, 'g1'), 4);

    // The survivors must be the most recent ones.
    const kept = recentMessages(db, 'g1', { limit: 10 }).map((row) => row.content);
    assert.ok(kept.some((content) => content.includes('number 9')));
    assert.equal(kept.some((content) => content.includes('number 0')), false);
    db.close();
});

// --- dialect profile ---------------------------------------------------------

test('profile surfaces server slang and ignores ordinary English', () => {
    const rows = [];
    for (let i = 0; i < 12; i++) {
        rows.push({ content: 'bawberry is holding site again', user_id: `u${i % 3}` });
        rows.push({ content: 'we should really think about that thing', user_id: `u${i % 3}` });
    }

    const profile = computeStyleProfile(rows);
    const vocabulary = profile.vocabulary.map((entry) => entry.term);

    assert.ok(vocabulary.includes('bawberry'), 'server-specific word should be learned');
    assert.ok(vocabulary.includes('site'), 'server jargon should be learned');
    // Words from the common-English list are subtracted out no matter how
    // often they appear — that subtraction is the whole mechanism.
    for (const common of ['think', 'about', 'that', 'really', 'should']) {
        assert.equal(vocabulary.includes(common), false, `"${common}" is ordinary English and should be filtered`);
    }
});

test('profile learns catchphrases and prefers the more specific form', () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
        rows.push({ content: 'holding site again lads', user_id: `u${i % 4}` });
    }
    const profile = computeStyleProfile(rows);
    const phrases = profile.phrases.map((entry) => entry.term);

    assert.ok(phrases.length > 0, 'expected catchphrases');
    assert.ok(phrases.some((phrase) => phrase.includes('holding site')));
    // "holding site" and "holding site again" must not both be listed.
    const overlapping = phrases.filter((a) => phrases.some((b) => a !== b && b.includes(a)));
    assert.deepEqual(overlapping, [], 'subsumed phrases should be dropped');
});

test('profile requires corroboration from multiple users on a large corpus', () => {
    // One person saying "zzzflarp" a lot is a personal tic, not server slang.
    const rows = [];
    for (let i = 0; i < 1200; i++) {
        rows.push({ content: 'bawberry holding site', user_id: `u${i % 5}` });
    }
    for (let i = 0; i < 20; i++) {
        rows.push({ content: 'zzzflarp zzzflarp', user_id: 'loner' });
    }

    const profile = computeStyleProfile(rows);
    const vocabulary = profile.vocabulary.map((entry) => entry.term);
    assert.ok(vocabulary.includes('bawberry'));
    assert.equal(vocabulary.includes('zzzflarp'), false, 'single-user words should not become server slang');
});

test('profile measures typing habits, and describeStyle turns them into rules', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
        content: 'bawberry holding site again lads',
        user_id: `u${i % 3}`,
    }));
    const profile = computeStyleProfile(rows);

    assert.ok(profile.style.lowercaseRatio > 0.9, 'all-lowercase corpus should register');
    assert.ok(profile.style.punctuationRatio < 0.1, 'no trailing full stops should register');

    const rules = describeStyle(profile.style).join(' ');
    assert.match(rules, /lowercase/i);
    assert.match(rules, /full stop/i);
});

test('getStyleProfile caches and recomputes on force', () => {
    const db = tempDb();
    seed(db, Array.from({ length: 30 }, (_, i) => [`u${i % 3}`, 'bawberry holding site again']));

    const first = getStyleProfile(db, 'g1');
    assert.ok(first.vocabulary.length > 0);

    // A cached profile is returned without rescanning; forcing picks up new
    // messages immediately.
    seed(db, Array.from({ length: 30 }, (_, i) => [`u${i % 3}`, 'deadlotting in the queue']));
    const forced = getStyleProfile(db, 'g1', { force: true });
    assert.ok(forced.vocabulary.some((entry) => entry.term === 'deadlotting'));
    db.close();
});

test('getStyleProfile returns null for a guild with no corpus', () => {
    const db = tempDb();
    assert.equal(getStyleProfile(db, 'unknown-guild'), null);
    db.close();
});

// --- retrieval ---------------------------------------------------------------

test('buildMatchQuery keeps distinctive terms, drops filler, and quotes them', () => {
    assert.equal(buildMatchQuery('what about the thing'), null, 'all-common text has nothing to search on');
    const query = buildMatchQuery('is bawberry holding site');
    assert.match(query, /"bawberry"/);
    assert.match(query, / OR /);
});

test('retrieval finds the server messages that mention the topic', () => {
    const db = tempDb();
    seed(db, [
        ['u1', 'bawberry always whiffs the opening duel'],
        ['u2', 'deadlotting again in ranked queue'],
        ['u3', 'someone get in vc we are five stacking'],
    ]);

    const hits = retrieveSimilar(db, 'g1', 'is bawberry any good');
    assert.ok(hits.length > 0, 'expected a precedent hit');
    assert.match(hits[0].content, /bawberry/);
    db.close();
});

test('retrieval is guild-scoped and safe on adversarial input', () => {
    const db = tempDb();
    seed(db, [['u1', 'bawberry whiffed mid']], { guildId: 'g1' });
    seed(db, [['u2', 'bawberry whiffed mid']], { guildId: 'g2' });

    assert.equal(retrieveSimilar(db, 'g1', 'bawberry').length, 1);

    // FTS5 syntax in user text must not throw or change the query's meaning.
    for (const hostile of ['bawberry" OR "', 'NEAR(bawberry site)', '*', 'a AND b OR (c)']) {
        assert.doesNotThrow(() => retrieveSimilar(db, 'g1', hostile), `crashed on: ${hostile}`);
    }
    db.close();
});

test('retrieval returns nothing rather than throwing without a db or guild', () => {
    assert.deepEqual(retrieveSimilar(null, 'g1', 'bawberry'), []);
    assert.deepEqual(retrieveSimilar({}, null, 'bawberry'), []);
});

// --- prompt assembly ---------------------------------------------------------

test('buildSystemPrompt injects dialect and precedent', () => {
    const db = tempDb();
    seed(db, Array.from({ length: 20 }, (_, i) => [`u${i % 3}`, 'bawberry is holding site again']));

    const prompt = buildSystemPrompt({ db, guildId: 'g1', queryText: 'what is bawberry doing' });

    assert.ok(prompt.startsWith(BASE_SYSTEM_PROMPT) || prompt.includes('limmygrok'));
    assert.match(prompt, /SERVER DIALECT/);
    assert.match(prompt, /bawberry/);
    assert.match(prompt, /SERVER PRECEDENT/);
    db.close();
});

test('buildSystemPrompt falls back to recent messages when nothing matches', () => {
    const db = tempDb();
    seed(db, Array.from({ length: 20 }, (_, i) => [`u${i % 3}`, 'bawberry is holding site again']));

    const prompt = buildSystemPrompt({ db, guildId: 'g1', queryText: 'zzzz unrelated topic' });
    assert.match(prompt, /RECENT SERVER MESSAGES/);
    db.close();
});

test('buildSystemPrompt degrades to the base persona with no corpus or no db', () => {
    const db = tempDb();
    assert.equal(buildSystemPrompt({ db, guildId: 'empty', queryText: 'anything' }).includes('SERVER DIALECT'), false);
    assert.equal(buildSystemPrompt({ db: null, guildId: 'g1' }).includes('SERVER DIALECT'), false);
    // A broken db must cost the persona, not the reply.
    const broken = { prepare: () => { throw new Error('db is closed'); } };
    assert.doesNotThrow(() => buildSystemPrompt({ db: broken, guildId: 'g1', queryText: 'x' }));
    db.close();
});

test('renderDialectBlock is empty when there is nothing learned', () => {
    assert.equal(renderDialectBlock(null), '');
    assert.equal(renderDialectBlock({ sampleSize: 0, vocabulary: [], phrases: [], style: null }), '');
});
