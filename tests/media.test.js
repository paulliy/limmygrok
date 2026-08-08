// Tests for utils/media.js — learning the server's own reaction GIFs and
// reusing them sparingly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../utils/db');
const {
    recordMedia,
    extractMedia,
    classifyUrl,
    buildContext,
    findMatchingMedia,
    pickGarnishGif,
    countMedia,
    forgetMedia,
} = require('../utils/media');
const { computeStyleProfile } = require('../utils/corpus');

function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limmygrok-media-'));
    return openDatabase(path.join(dir, 'test.sqlite'));
}

const TENOR = 'https://tenor.com/view/limmy-whiff-gif-12345';
const TENOR_2 = 'https://tenor.com/view/deadlot-queue-gif-777';

// --- classification ----------------------------------------------------------

test('recognises links Discord will unfurl as a gif or image', () => {
    assert.equal(classifyUrl(TENOR), 'gif');
    assert.equal(classifyUrl('https://media.giphy.com/media/abc/giphy.gif'), 'gif');
    assert.equal(classifyUrl('https://cdn.discordapp.com/attachments/1/2/clip.gif'), 'gif');
    assert.equal(classifyUrl('https://cdn.discordapp.com/attachments/1/2/pic.png'), 'image');
    assert.equal(classifyUrl('https://i.imgur.com/abc.jpg'), 'image');
});

test('ignores links that would not render as media', () => {
    assert.equal(classifyUrl('https://example.com/page'), null);
    assert.equal(classifyUrl('https://github.com/paulliy/limmygrok'), null);
    // A Discord CDN link to something that is not an image.
    assert.equal(classifyUrl('https://cdn.discordapp.com/attachments/1/2/notes.txt'), null);
    assert.equal(classifyUrl('not a url'), null);
    assert.equal(classifyUrl(''), null);
});

test('extracts media from message text and from attachments', () => {
    const found = extractMedia(`lmao ${TENOR}`, [
        { url: 'https://cdn.discordapp.com/a/b/c.gif', contentType: 'image/gif' },
        { url: 'https://cdn.discordapp.com/a/b/d.png', contentType: 'image/png' },
        { url: 'https://cdn.discordapp.com/a/b/e.txt', contentType: 'text/plain' },
    ]);
    const urls = found.map((entry) => entry.url);

    assert.ok(urls.includes(TENOR));
    assert.equal(found.find((entry) => entry.url.endsWith('c.gif')).kind, 'gif');
    assert.equal(found.find((entry) => entry.url.endsWith('d.png')).kind, 'image');
    assert.equal(urls.some((url) => url.endsWith('e.txt')), false, 'non-images are ignored');
});

// --- context -----------------------------------------------------------------

test('context comes mostly from the message being reacted to', () => {
    // A reaction GIF usually has no text of its own, so without the preceding
    // message it would be unsearchable.
    const context = buildContext('', 'bawberry whiffed the opening duel again');
    assert.match(context, /bawberry whiffed/);
});

test('context strips links so only the words are indexed', () => {
    const context = buildContext(`lmao ${TENOR}`, 'bawberry whiffed');
    assert.equal(context.includes('tenor.com'), false);
    assert.match(context, /lmao/);
    assert.match(context, /bawberry whiffed/);
});

// --- recording ---------------------------------------------------------------

test('a gif is stored once per url, with a use count', () => {
    const db = tempDb();
    recordMedia(db, { guildId: 'g1', content: TENOR, precedingText: 'bawberry whiffed mid' });
    recordMedia(db, { guildId: 'g1', content: TENOR, precedingText: 'he whiffed again' });

    assert.equal(countMedia(db, 'g1'), 1, 'the same gif twice is one reaction, not two');
    const row = db.prepare('SELECT uses, context FROM corpus_media WHERE url = ?').get(TENOR);
    assert.equal(row.uses, 2);
    // Both situations it was used in stay searchable.
    assert.match(row.context, /whiffed again/);
    assert.match(row.context, /whiffed mid/);
    db.close();
});

test('messages with no media record nothing', () => {
    const db = tempDb();
    assert.equal(recordMedia(db, { guildId: 'g1', content: 'just talking here' }), 0);
    assert.equal(countMedia(db, 'g1'), 0);
    db.close();
});

test('recording is safe without a db or guild', () => {
    assert.equal(recordMedia(null, { guildId: 'g1', content: TENOR }), 0);
    assert.equal(recordMedia({}, { content: TENOR }), 0);
});

// --- retrieval ---------------------------------------------------------------

function seedGifs(db) {
    // Established enough to be reused (uses >= 2).
    for (let i = 0; i < 3; i++) {
        recordMedia(db, { guildId: 'g1', content: TENOR, precedingText: 'bawberry whiffed the opening duel' });
        recordMedia(db, { guildId: 'g1', content: TENOR_2, precedingText: 'deadlotting in ranked queue' });
    }
}

test('retrieval finds the gif the server posts for this situation', () => {
    const db = tempDb();
    seedGifs(db);

    const hits = findMatchingMedia(db, 'g1', 'bawberry whiffed again');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].url, TENOR, 'should pick the whiff gif, not the deadlot one');

    const other = findMatchingMedia(db, 'g1', 'deadlotting queue');
    assert.equal(other[0].url, TENOR_2);
    db.close();
});

test('a gif posted only once is not yet a habit', () => {
    const db = tempDb();
    recordMedia(db, { guildId: 'g1', content: TENOR, precedingText: 'bawberry whiffed the opening duel' });
    assert.equal(findMatchingMedia(db, 'g1', 'bawberry whiffed').length, 0);
    db.close();
});

test('retrieval is guild-scoped and survives hostile input', () => {
    const db = tempDb();
    seedGifs(db);
    assert.equal(findMatchingMedia(db, 'other-guild', 'bawberry whiffed').length, 0);

    for (const hostile of ['bawberry" OR "', 'NEAR(a b)', '*', '']) {
        assert.doesNotThrow(() => findMatchingMedia(db, 'g1', hostile), `crashed on: ${hostile}`);
    }
    db.close();
});

test('forgetMedia reports gifs, not driver row-writes', () => {
    const db = tempDb();
    seedGifs(db);
    assert.equal(countMedia(db, 'g1'), 2);
    assert.equal(forgetMedia(db, 'g1'), 2);
    assert.equal(countMedia(db, 'g1'), 0);
    db.close();
});

// --- the garnish policy ------------------------------------------------------

const always = () => 0;   // random() = 0 -> always inside the chance gate
const never = () => 0.99; // random() = 0.99 -> always outside it

test('a gif is posted when topic, dice and cooldown all allow it', () => {
    const db = tempDb();
    seedGifs(db);
    const url = pickGarnishGif(db, 'g1', 'bawberry whiffed', {
        channelId: 'c1', cooldowns: new Map(), random: always,
    });
    assert.equal(url, TENOR);
    db.close();
});

test('the dice gate keeps it rare', () => {
    const db = tempDb();
    seedGifs(db);
    assert.equal(pickGarnishGif(db, 'g1', 'bawberry whiffed', {
        channelId: 'c1', cooldowns: new Map(), random: never,
    }), null);
    db.close();
});

test('the cooldown stops two gifs landing back to back', () => {
    const db = tempDb();
    seedGifs(db);
    const cooldowns = new Map();

    const first = pickGarnishGif(db, 'g1', 'bawberry whiffed', { channelId: 'c1', cooldowns, random: always });
    assert.ok(first, 'first should fire');

    const second = pickGarnishGif(db, 'g1', 'bawberry whiffed', { channelId: 'c1', cooldowns, random: always });
    assert.equal(second, null, 'second is inside the cooldown window');

    // A different channel has its own cooldown.
    assert.ok(pickGarnishGif(db, 'g1', 'bawberry whiffed', { channelId: 'c2', cooldowns, random: always }));

    // And the window does expire.
    const later = pickGarnishGif(db, 'g1', 'bawberry whiffed', {
        channelId: 'c1', cooldowns, random: always, now: Date.now() + 60 * 60 * 1000,
    });
    assert.ok(later, 'should fire again once the cooldown has passed');
    db.close();
});

test('no gif when nothing matches the topic', () => {
    const db = tempDb();
    seedGifs(db);
    assert.equal(pickGarnishGif(db, 'g1', 'unrelated zzzz topic', {
        channelId: 'c1', cooldowns: new Map(), random: always,
    }), null);
    db.close();
});

test('the cooldown is not consumed when no gif is posted', () => {
    const db = tempDb();
    seedGifs(db);
    const cooldowns = new Map();
    pickGarnishGif(db, 'g1', 'unrelated zzzz topic', { channelId: 'c1', cooldowns, random: always });
    assert.equal(cooldowns.has('c1'), false, 'a miss must not start the cooldown');
    // So a real match right after still fires.
    assert.ok(pickGarnishGif(db, 'g1', 'bawberry whiffed', { channelId: 'c1', cooldowns, random: always }));
    db.close();
});

test('garnish selection is safe with missing arguments', () => {
    assert.equal(pickGarnishGif(null, 'g1', 'x', { channelId: 'c1' }), null);
    assert.equal(pickGarnishGif({}, 'g1', 'x', {}), null, 'no channel means no cooldown to honour');
});

// --- custom emoji regression -------------------------------------------------

test('custom emoji keep their IDs so Discord can render them', () => {
    // Regression: only the name was stored, so the model was coached to emit
    // ":limmy:", which Discord renders as literal text.
    const rows = Array.from({ length: 8 }, (_, i) => ({
        content: 'holding site <:limmy:123456> lads',
        user_id: `u${i % 3}`,
    }));
    const profile = computeStyleProfile(rows);
    const emoji = profile.customEmoji.map((entry) => entry.term);

    assert.ok(emoji.includes('<:limmy:123456>'), `expected the renderable form, got ${JSON.stringify(emoji)}`);
    assert.equal(emoji.includes(':limmy:'), false, 'the bare name is not renderable');
});

test('animated custom emoji keep their animated form', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
        content: 'lets go <a:party:987654>',
        user_id: `u${i % 3}`,
    }));
    const profile = computeStyleProfile(rows);
    assert.ok(profile.customEmoji.map((entry) => entry.term).includes('<a:party:987654>'));
});
