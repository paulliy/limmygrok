// Discord CDN links are signed and expire. Conversation memory holds image
// turns for up to MEMORY_LIMIT messages, so without handling this an image
// posted hours ago keeps riding along on every later reply — routed to the
// pricier vision model, carrying a URL that resolves to nothing.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const realConsoleError = console.error;
beforeEach(() => { console.error = () => {}; });
afterEach(() => { console.error = realConsoleError; });

const { isExpiredDiscordUrl, resolveImageUrlsToBase64 } = require('../utils/parseimgs');
const { pickModel, messagesContainImages } = require('../utils/llm');

const HOUR = 60 * 60 * 1000;
// Discord encodes the expiry as a hex unix timestamp in the `ex` param.
const hexTime = (ms) => Math.floor(ms / 1000).toString(16);
const discordUrl = (expiresAt) =>
    `https://cdn.discordapp.com/attachments/1/2/pic.png?ex=${hexTime(expiresAt)}&is=${hexTime(expiresAt - HOUR)}&hm=abc`;

// --- detection ---------------------------------------------------------------

test('a lapsed signature is recognised, a live one is not', () => {
    const now = Date.now();
    assert.equal(isExpiredDiscordUrl(discordUrl(now - HOUR), now), true);
    assert.equal(isExpiredDiscordUrl(discordUrl(now + HOUR), now), false);
});

test('anything without a readable expiry is treated as live', () => {
    const now = Date.now();
    // Dropping a valid image is worse than attempting one that fails, so the
    // check only fires when it is certain.
    assert.equal(isExpiredDiscordUrl('https://cdn.discordapp.com/attachments/1/2/pic.png', now), false);
    assert.equal(isExpiredDiscordUrl('https://cdn.discordapp.com/a/b/c.png?ex=nothex', now), false);
    assert.equal(isExpiredDiscordUrl('not a url', now), false);
    assert.equal(isExpiredDiscordUrl('', now), false);
});

test('only Discord CDN hosts are subject to the expiry rule', () => {
    const now = Date.now();
    // Another host's `ex` param means something else entirely.
    assert.equal(isExpiredDiscordUrl(`https://example.com/pic.png?ex=${hexTime(now - HOUR)}`, now), false);
});

// --- effect on the payload ---------------------------------------------------

test('an expired image is dropped, and never fetched', async () => {
    const originalFetch = global.fetch;
    let fetched = false;
    global.fetch = async () => { fetched = true; throw new Error('should not be called'); };

    try {
        const resolved = await resolveImageUrlsToBase64([{
            role: 'user',
            content: [
                { type: 'text', text: 'what do you make of this' },
                { type: 'image_url', image_url: { url: discordUrl(Date.now() - HOUR) } },
            ],
        }]);

        assert.equal(resolved.length, 1);
        assert.deepEqual(resolved[0].content, [{ type: 'text', text: 'what do you make of this' }]);
        assert.equal(fetched, false, 'a doomed fetch should be skipped entirely');
    } finally {
        global.fetch = originalFetch;
    }
});

test('an image-only turn whose image expired is dropped rather than sent empty', async () => {
    const resolved = await resolveImageUrlsToBase64([
        { role: 'user', content: [{ type: 'image_url', image_url: { url: discordUrl(Date.now() - HOUR) } }] },
        { role: 'assistant', content: 'yeah' },
    ]);

    // An empty content array is an API error, so the turn goes entirely.
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].role, 'assistant');
});

test('a live image still resolves normally', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => Buffer.from('abc'),
    });

    try {
        const resolved = await resolveImageUrlsToBase64([{
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: discordUrl(Date.now() + HOUR) } }],
        }]);
        assert.equal(resolved[0].content[0].image_url.url, 'data:image/png;base64,YWJj');
    } finally {
        global.fetch = originalFetch;
    }
});

// --- the point of the whole exercise ----------------------------------------

test('a stale image no longer drags the request onto the vision model', async () => {
    const config = { MODEL_NAME: 'cheap-text-model', VISION_MODEL: 'pricey-vision-model' };

    // A channel where somebody posted a picture hours ago and the
    // conversation has moved on.
    const turns = [
        { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: discordUrl(Date.now() - HOUR) } }] },
        { role: 'assistant', content: 'lol' },
        { role: 'user', content: 'anyway who is holding site' },
    ];

    assert.equal(messagesContainImages(turns), true, 'the raw window still has the image part');
    assert.equal(pickModel(config, turns), 'pricey-vision-model', 'which is what used to happen');

    // utils/reply.js resolves before choosing the model, so the choice is made
    // on what survived.
    const resolved = await resolveImageUrlsToBase64(turns);
    assert.equal(messagesContainImages(resolved), false);
    assert.equal(pickModel(config, resolved), 'cheap-text-model');
});
