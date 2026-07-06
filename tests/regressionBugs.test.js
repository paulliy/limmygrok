// Regression + adversarial tests.
//
// Every test in here is written to be DISCRIMINATING: it fails against the
// buggy version of the code and passes against the fixed one. A test that
// passes no matter what is a "bad test case" and is deliberately excluded
// (e.g. the "repeated image URL" scenario, where the old String.replace loop
// happened to remove every occurrence anyway, so no assertion could tell the
// two implementations apart).
//
// The last test started life as an [EXPECTED FAIL] adversarial probe that
// surfaced a real latent bug in mention.js's dedup logic; that bug is now fixed,
// so it stands as a regression guard.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const realConsoleLog = console.log;
const realConsoleError = console.error;
const realStdoutWrite = process.stdout.write;

beforeEach(() => {
    console.log = () => {};
    console.error = () => {};
    process.stdout.write = () => true;
});

afterEach(() => {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    process.stdout.write = realStdoutWrite;
});

// --- Mock discord.js so the event modules can be required in isolation ---
const mockDiscord = {
    Events: { MessageCreate: 'messageCreate' },
    Collection: class MockCollection extends Map {},
};

require.cache[require.resolve('discord.js')] = {
    id: require.resolve('discord.js'),
    filename: require.resolve('discord.js'),
    loaded: true,
    exports: mockDiscord,
};

const autoresponce = require('../events/autoresponce');
const messageStore = require('../events/messageStore');
const mention = require('../events/mention');

// A message whose reply/edit calls are captured so assertions can inspect them.
function createCapturingMessage({
    content = '',
    channelId = 'ch-1',
    memory = new Map(),
    messageCounts = new Map(),
    cooldowns = new Map(),
    openWebUI = null,
    mentions = null,
    attachments = [],
    replyThrows = false,
} = {}) {
    const replyEdits = [];
    const message = {
        author: { bot: false, id: 'user-456' },
        content,
        channel: {
            id: channelId,
            sendTyping: async () => {},
        },
        client: {
            memory,
            messageCounts,
            cooldowns,
            openWebUI,
            user: { id: 'bot-123', username: 'limmybot' },
        },
        attachments: new Map(attachments.map((att, i) => [`att-${i}`, att])),
        reply: async (initial) => {
            if (replyThrows) throw new Error('Discord API Error: cannot send message');
            const replyMsg = {
                content: initial,
                edit: async (next) => { replyEdits.push(next); replyMsg.content = next; return replyMsg; },
                delete: async () => {},
            };
            return replyMsg;
        },
        mentions: mentions || { has: () => false, roles: new Map() },
    };
    return { message, replyEdits };
}

// An OpenWebUI stub that streams a single chunk containing `fullText`.
function streamingOpenAI(fullText) {
    return {
        chat: {
            completions: {
                create: async () => (async function* () {
                    yield { choices: [{ delta: { content: fullText } }] };
                })(),
            },
        },
    };
}

// ============================================================
// REGRESSION: these pass now, and would FAIL before the fixes.
// ============================================================

test('regression: a long auto-response is never edited past Discord\'s 2000-char limit', async () => {
    // Pre-fix this produced slice(0,1997) + "/..." = 2001 chars -> edit() throws.
    const memory = new Map([['ch-1', [{ role: 'user', content: 'give me a wall of text' }]]]);
    const longReply = 'a'.repeat(3000); // no <think> tags, no [n] citations
    const { message, replyEdits } = createCapturingMessage({
        channelId: 'ch-1',
        memory,
        openWebUI: streamingOpenAI(longReply),
    });

    await autoresponce.generateAutoresponce(message);

    assert.ok(replyEdits.length > 0, 'the reply should have been edited at least once');
    for (const edit of replyEdits) {
        assert.equal(typeof edit, 'string');
        assert.ok(edit.length <= 2000, `edit exceeded Discord limit: ${edit.length} chars`);
    }
    // Prove the truncation branch actually ran (long content -> exactly 2000).
    assert.equal(replyEdits[replyEdits.length - 1].length, 2000);
});

test('regression: messageStore does not double-store a message that mentions the bot', async () => {
    // The mention handler owns @-mention messages. messageStore must skip them
    // so the same turn is not stored twice regardless of listener order.
    const memory = new Map();
    const messageCounts = new Map();
    const mentions = { has: () => true, roles: new Map() };
    const { message } = createCapturingMessage({
        content: '<@bot-123> hello there',
        channelId: 'ch-1',
        memory,
        messageCounts,
        mentions,
    });

    await messageStore.execute(message);

    assert.equal(memory.get('ch-1'), undefined, 'messageStore should not have stored the mention');
    assert.ok(!messageCounts.get('ch-1'), 'messageStore should not have counted the mention');
});

test('regression: generateAutoresponce swallows a failing initial reply instead of rejecting', async () => {
    // Pre-fix the initial message.reply() was awaited outside the try/catch, so
    // a failure escaped as an unhandled rejection (and crashed messageStore's await).
    const memory = new Map([['ch-1', [{ role: 'user', content: 'hi' }]]]);
    const { message } = createCapturingMessage({
        channelId: 'ch-1',
        memory,
        openWebUI: streamingOpenAI('never gets here'),
        replyThrows: true,
    });

    await assert.doesNotReject(() => autoresponce.generateAutoresponce(message));
});

// ============================================================
// REGRESSION: this exposed a real latent bug (now fixed).
// Before the fix it failed; it passes now.
// ============================================================

test('regression: mention dedup must not drop an unrelated prior message that merely contains the bot id', async () => {
    // mention.js dedups with `lastContentStr.includes(message.client.user.id)`.
    // If the previous, unrelated user message happens to contain the bot id as a
    // substring, the new mention OVERWRITES it and that history is silently lost.
    const memory = new Map([['ch-1', [
        { role: 'user', content: 'lol my old discord id was bot-123 back in the day' },
    ]]]);
    const mentions = { has: () => true, roles: new Map() };
    const { message } = createCapturingMessage({
        content: '<@bot-123> what time is it',
        channelId: 'ch-1',
        memory,
        openWebUI: streamingOpenAI('it is noon'),
        mentions,
    });

    await mention.execute(message);

    const history = memory.get('ch-1') || [];
    const userTurns = history.filter((m) => m.role === 'user');
    assert.equal(userTurns.length, 2,
        'the unrelated prior message should be preserved and the new one appended, not overwritten');
});
