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
    guildCount,
    tokenize,
    isLearnable,
    normalizeForLearning,
} = require('../utils/corpus');
const {
    buildSystemPrompt,
    buildReplyContext,
    renderDialectBlock,
    renderPrecedent,
    conversationText,
    describeStyle,
    relativeAge,
    BASE_SYSTEM_PROMPT,
} = require('../utils/prompt');

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

// --- retrieval quality: term-overlap re-ranking, dedup, context, recency ----

test('retrieval prefers a message matching more of the question over a single rare-word coincidence', () => {
    const db = tempDb();
    seed(db, [
        // Shares only "weather" with the query below — a lucky single-term hit.
        ['a', 'the weather today is oddly nice for once around here'],
        // Shares several distinct query terms — actually about the question.
        ['b', 'bawberry always whiffs the opening duel every single game'],
    ]);

    const hits = retrieveSimilar(db, 'g1', 'bawberry whiffs the opening duel weather');
    assert.match(hits[0].content, /whiffs the opening duel/, 'broader overlap should outrank a coincidental rare-term match');
    db.close();
});

test('near-identical reposts of the same line are collapsed to one precedent slot', () => {
    const db = tempDb();
    seed(db, [
        ['a', 'holding site again lads'],
        ['b', 'holding site again lads'],
        ['c', 'holding site again LADS'],
        ['d', 'deadlotting in ranked queue tonight'],
    ]);

    const hits = retrieveSimilar(db, 'g1', 'holding site lads deadlotting queue');
    const holdingSiteHits = hits.filter((h) => /holding site/.test(h.content));
    assert.equal(holdingSiteHits.length, 1, 'the repeated line should only take one slot, leaving room for other precedent');
    db.close();
});

test('a short or pronoun-led hit carries the message it followed', () => {
    const db = tempDb();
    seed(db, [
        ['limmy', 'bawberry never opens correctly on this map'],
        ['gene', 'he never opens correctly either honestly'],
    ]);

    const hits = retrieveSimilar(db, 'g1', 'does he ever open correctly');
    const pronounHit = hits.find((h) => h.content.startsWith('he '));
    assert.ok(pronounHit, 'expected the pronoun-led message to be retrieved');
    assert.equal(pronounHit.precedingAuthor, 'limmy');
    assert.match(pronounHit.precedingContent, /bawberry never opens/);
    db.close();
});

test('a self-contained hit does not carry preceding context it does not need', () => {
    const db = tempDb();
    seed(db, [
        ['limmy', 'unrelated setup message about something else entirely'],
        ['gene', 'bawberry consistently whiffs the opening duel in every single ranked match'],
    ]);

    const hits = retrieveSimilar(db, 'g1', 'bawberry whiffs the opening duel');
    const hit = hits.find((h) => h.content.includes('bawberry consistently whiffs'));
    assert.equal(hit.precedingContent, undefined, 'a long, self-contained message should not need borrowed context');
    db.close();
});

test('retrieval degrades safely when there is nothing to attach context to', () => {
    const db = tempDb();
    // A pronoun-led hit with nothing before it in the channel.
    seed(db, [['gene', 'he whiffed again honestly unbelievable']]);
    const hits = retrieveSimilar(db, 'g1', 'did he whiff whiffed again');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].precedingContent, undefined);
    db.close();
});

// --- renderPrecedent: recency, context, corroboration -----------------------

const DAY_MS = 24 * 60 * 60 * 1000;

test('relativeAge reads naturally across the scale', () => {
    const now = Date.now();
    assert.equal(relativeAge(now), 'today');
    assert.equal(relativeAge(now - DAY_MS), '1d ago');
    assert.equal(relativeAge(now - 5 * DAY_MS), '5d ago');
    assert.equal(relativeAge(now - 60 * DAY_MS), '2mo ago');
    assert.equal(relativeAge(now - 400 * DAY_MS), '1y ago');
    assert.equal(relativeAge(null), '');
});

test('renderPrecedent tags each line with its age and inline context', () => {
    const rows = [
        { author: 'gene', userId: 'gene', content: 'he never opens correctly', ts: Date.now(), precedingAuthor: 'limmy', precedingContent: 'bawberry never opens correctly' },
        { author: 'limmy', userId: 'limmy', content: 'bawberry never opens correctly', ts: Date.now() - DAY_MS },
    ];
    const rendered = renderPrecedent(rows, { heading: 'SERVER PRECEDENT:' });

    assert.match(rendered, /gene: he never opens correctly \(today\) \[replying to limmy: "bawberry never opens correctly"\]/);
    assert.match(rendered, /limmy: bawberry never opens correctly \(1d ago\)/);
});

test('renderPrecedent flags a claim sourced from only one person', () => {
    const single = [
        { author: 'solo', userId: 'solo', content: 'deadlot is actually good trust me', ts: Date.now() },
    ];
    assert.match(renderPrecedent(single, { heading: 'SERVER PRECEDENT:' }), /all from the same person/);

    const corroborated = [
        { author: 'a', userId: 'a', content: 'deadlot is actually good', ts: Date.now() },
        { author: 'b', userId: 'b', content: 'yeah deadlot is solid', ts: Date.now() },
    ];
    assert.equal(renderPrecedent(corroborated, { heading: 'SERVER PRECEDENT:' }).includes('all from the same person'), false);
});

test('renderPrecedent falls back to author when userId is absent, without crashing', () => {
    const rows = [{ author: 'solo', content: 'x', ts: Date.now() }];
    assert.doesNotThrow(() => renderPrecedent(rows, { heading: 'H:' }));
});

// --- buildReplyContext: anti-fabrication instruction -------------------------

test('buildReplyContext instructs the model not to invent facts beyond precedent', () => {
    const db = tempDb();
    seed(db, Array.from({ length: 20 }, (_, i) => [`u${i % 3}`, 'bawberry is holding site again']));
    const { systemPrompt } = buildReplyContext({ db, guildId: 'g1', queryText: 'bawberry' });
    assert.match(systemPrompt, /say you don't know rather than making one up/i);
    assert.match(systemPrompt, /trust the more recent line/i);
    db.close();
});

// --- conversationText (shared helper) ----------------------------------------

test('conversationText flattens both string and content-part turns', () => {
    const messages = [
        { role: 'user', content: 'plain string turn' },
        { role: 'user', content: [{ type: 'text', text: 'part-based turn' }, { type: 'image_url', image_url: { url: 'x' } }] },
    ];
    const flattened = conversationText(messages);
    assert.match(flattened, /plain string turn/);
    assert.match(flattened, /part-based turn/);
    assert.equal(flattened.includes('image_url'), false, 'image parts contribute nothing but should not throw');
});

test('conversationText respects the limit and handles empty input', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `turn ${i}` }));
    const flattened = conversationText(messages, 3);
    assert.equal(flattened.includes('turn 6'), false);
    assert.match(flattened, /turn 7/);
    assert.match(flattened, /turn 9/);
    assert.equal(conversationText([]), '');
});

// --- retrieval query shape: guild isolation + bounded work ------------------

test('retrieval never leaks another guild\'s messages', () => {
    const db = tempDb();
    seed(db, Array.from({ length: 40 }, (_, i) => ['u1', `bawberry holding site number ${i}`]), { guildId: 'g1' });
    seed(db, Array.from({ length: 40 }, (_, i) => ['u2', `bawberry holding site number ${i}`]), { guildId: 'g2' });

    // Ranking happens inside FTS across every guild and the guild filter is
    // applied to the survivors, so this is the invariant that matters most.
    for (const guild of ['g1', 'g2']) {
        const hits = retrieveSimilar(db, guild, 'bawberry holding site');
        assert.ok(hits.length > 0, `expected hits for ${guild}`);
        const authors = new Set(hits.map((h) => h.author));
        assert.deepEqual([...authors], [guild === 'g1' ? 'u1' : 'u2'], `${guild} got another guild's messages`);
    }
    db.close();
});

test('the precedent pool still fills when several guilds share the corpus', () => {
    const db = tempDb();
    // Three guilds saying near-identical things: without widening the ranked
    // pool, the other two would crowd this guild out of the top-N entirely.
    for (const guild of ['g1', 'g2', 'g3']) {
        seed(db, Array.from({ length: 60 }, (_, i) => [`u-${guild}`, `bawberry holding site again ${i}`]), { guildId: guild });
    }

    const hits = retrieveSimilar(db, 'g2', 'bawberry holding site again', { limit: 6 });
    assert.equal(hits.length, 6, 'should still fill all six precedent slots');
    db.close();
});

test('guildCount reports how many guilds have been learned from', () => {
    const db = tempDb();
    assert.equal(guildCount(db), 1, 'an empty corpus should not report zero and break pool sizing');
    seed(db, [['u1', 'bawberry holding site']], { guildId: 'g1' });
    seed(db, [['u2', 'bawberry holding site']], { guildId: 'g2' });
    assert.equal(guildCount(db), 2);
    db.close();
});

// Retrieval used to join every matching row before sorting, so a query term
// that appeared in most messages cost time proportional to the whole corpus
// (measured: 225 ms at 1,200 messages, and superlinear from there). Ranking
// inside FTS first brought that to ~1.7 ms. The bound below is deliberately
// enormous — this is here to catch the query shape being reverted, not to
// measure performance, so it must not turn flaky on a loaded CI box.
test('retrieval stays fast when a query term matches almost the whole corpus', () => {
    const db = tempDb();
    seed(db, Array.from({ length: 3000 }, (_, i) => [`u${i % 6}`, 'holding site lads queue again']));

    const started = Date.now();
    for (let i = 0; i < 5; i++) retrieveSimilar(db, 'g1', 'holding site lads queue');
    const perCall = (Date.now() - started) / 5;

    assert.ok(perCall < 400, `retrieval took ${perCall.toFixed(0)}ms/call — the join is probably happening before the sort again`);
    db.close();
});
