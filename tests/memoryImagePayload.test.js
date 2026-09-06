const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

const realConsoleLog = console.log;
const realConsoleError = console.error;
const realStdoutWrite = process.stdout.write;
const realFetch = global.fetch;
const MOCK_IMAGE_DATA_URL = 'data:image/png;base64,aW1hZ2U=';

beforeEach(() => {
    console.log = () => {};
    console.error = () => {};
    process.stdout.write = () => true;
    global.fetch = async () => ({
        ok: true,
        headers: {
            get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null,
        },
        arrayBuffer: async () => Buffer.from('image'),
    });
});

afterEach(() => {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    process.stdout.write = realStdoutWrite;
    global.fetch = realFetch;
});

// --- Mocking Discord.js ---
const mockDiscord = {
    Events: {
        MessageCreate: 'messageCreate',
    },
    Collection: class MockCollection extends Map {}
};

require.cache[require.resolve('discord.js')] = {
    id: require.resolve('discord.js'),
    filename: require.resolve('discord.js'),
    loaded: true,
    exports: mockDiscord
};

// Import modules under test
const { parseimgs } = require('../utils/parseimgs');
const autoresponce = require('../events/autoresponce');

// Spy/stub generateAutoresponce before requiring messageStore
const spyGenerateAutoresponce = mockFn(autoresponce.generateAutoresponce);
autoresponce.generateAutoresponce = spyGenerateAutoresponce;

const messageStore = require('../events/messageStore');
const mention = require('../events/mention');
const config = require('../config.json');

// Custom mockFn implementation for compatibility
function mockFn(originalFn) {
    const fn = function(...args) {
        fn.calls.push({ arguments: args });
        if (originalFn) {
            return originalFn.apply(this, args);
        }
    };
    fn.calls = [];
    fn.mock = {
        get calls() { return fn.calls; }
    };
    return fn;
}

// Helper to create mock Discord Messages
function createMockMessage({
    content = '',
    bot = false,
    channelId = 'ch-1',
    attachments = [],
    memory = new Map(),
    messageCounts = new Map(),
    cooldowns = new Map(),
    llm = null,
    mentions = null
} = {}) {
    const message = {
        author: { bot },
        content,
        channel: {
            id: channelId,
            sendTyping: mockFn(async () => {})
        },
        client: {
            memory,
            messageCounts,
            cooldowns,
            llm,
            // Allow this channel so messageStore's ambient path runs in tests.
            allowedChannels: new Map([[channelId, 'guild-test']]),
            user: { id: 'bot-123', username: 'limmybot' }
        },
        attachments: new Map(attachments.map((att, i) => [`att-${i}`, att])),
        reply: mockFn(async (replyContent) => {
            const replyMsg = {
                edit: mockFn(async (newContent) => {
                    replyMsg.content = newContent;
                    return replyMsg;
                }),
                delete: mockFn(async () => {}),
                content: replyContent
            };
            return replyMsg;
        }),
        mentions: mentions || {
            has: mockFn(() => false),
            roles: new Map()
        }
    };
    return message;
}

// Helper to create mock OpenAI completions client
function createMockOpenAI(onPayloadCaptured) {
    return {
        chat: {
            completions: {
                create: mockFn(async (payload) => {
                    if (onPayloadCaptured) {
                        onPayloadCaptured(payload);
                    }
                    return {
                        [Symbol.asyncIterator]: async function* () {
                            yield { choices: [{ delta: { content: 'Hello' } }] };
                            yield { choices: [{ delta: { content: ' world!' } }] };
                        }
                    };
                })
            }
        }
    };
}

// ==========================================
// TIER 1: FEATURE COVERAGE
// ==========================================

test('test_t1_store_text_user_message - verifies plain text user message is stored as flat object in client memory', async () => {
    const memory = new Map();
    const messageCounts = new Map();
    const message = createMockMessage({
        content: 'hello bot',
        bot: false,
        channelId: 'ch-1',
        memory,
        messageCounts
    });
    
    await messageStore.execute(message);
    
    const history = memory.get('ch-1');
    assert.ok(history, 'Memory should contain history for channel');
    assert.equal(history.length, 1);
    assert.deepEqual(history[0], { role: 'user', content: 'hello bot' });
});

test('test_t1_store_text_assistant_message - verifies assistant message is appended to client memory as a flat object', async () => {
    const memory = new Map();
    memory.set('ch-1', [{ role: 'user', content: 'hello bot' }]);
    
    const llm = createMockOpenAI();
    const message = createMockMessage({
        content: 'hello bot',
        bot: false,
        channelId: 'ch-1',
        memory,
        llm
    });
    
    // We call generateAutoresponce directly
    await autoresponce.generateAutoresponce(message);
    
    const history = memory.get('ch-1');
    assert.ok(history);
    assert.equal(history.length, 2);
    assert.deepEqual(history[1], { role: 'assistant', content: 'Hello world!' });
});

test('test_t1_extract_image_attachment - extracts image/png and formats as OpenAI parts', () => {
    const msg = {
        author: { bot: false },
        content: 'look at this image',
        attachments: new Map([
            ['att-1', { contentType: 'image/png', url: 'https://example.com/img.png' }]
        ])
    };
    
    const parsed = parseimgs(msg);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], {
        role: 'user',
        content: [
            { type: 'text', text: 'look at this image' },
            { type: 'image_url', image_url: { url: 'https://example.com/img.png' } }
        ]
    });
});

test('test_t1_extract_image_url - extracts plain text image URLs', () => {
    const msg = {
        author: { bot: false },
        content: 'here is a link https://example.com/cat.jpg and some text',
        attachments: new Map()
    };
    
    const parsed = parseimgs(msg);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], {
        role: 'user',
        content: [
            { type: 'text', text: 'here is a link  and some text' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } }
        ]
    });
});

test('test_t1_flat_payload_auto_response - verifies autoresponse delivers flat payload to OpenAI', async () => {
    const memory = new Map();
    memory.set('ch-1', [
        { role: 'user', content: 'message 1' },
        { role: 'assistant', content: 'response 1' },
        { role: 'user', content: 'message 2' }
    ]);
    
    let capturedPayload = null;
    const llm = createMockOpenAI((payload) => {
        capturedPayload = payload;
    });
    
    const message = createMockMessage({
        channelId: 'ch-1',
        memory,
        llm
    });
    
    await autoresponce.generateAutoresponce(message);
    
    assert.ok(capturedPayload, 'API should have been called');
    assert.ok(Array.isArray(capturedPayload.messages), 'messages should be an array');
    for (const msg of capturedPayload.messages) {
        assert.equal(typeof msg, 'object');
        assert.ok(!Array.isArray(msg), 'Message should not be an array');
        assert.ok(msg.role);
        assert.ok(msg.content);
    }
});

test('test_t1_flat_payload_mention - verifies mention delivers flat payload to OpenAI', async () => {
    const memory = new Map();
    memory.set('ch-1', [
        { role: 'user', content: 'message 1' },
        { role: 'assistant', content: 'response 1' }
    ]);
    
    let capturedPayload = null;
    const llm = createMockOpenAI((payload) => {
        capturedPayload = payload;
    });
    
    const mentions = {
        has: mockFn(() => true),
        roles: new Map()
    };
    
    const message = createMockMessage({
        content: '<@bot-123> help me',
        channelId: 'ch-1',
        memory,
        llm,
        mentions
    });
    
    await mention.execute(message);
    
    assert.ok(capturedPayload, 'API should have been called');
    assert.ok(Array.isArray(capturedPayload.messages));
    for (const msg of capturedPayload.messages) {
        assert.equal(typeof msg, 'object');
        assert.ok(!Array.isArray(msg));
        assert.ok(msg.role);
        assert.ok(msg.content);
    }
});

// ==========================================
// TIER 2: BOUNDARY & EDGE CASES
// ==========================================

test('test_t2_empty_content_message - handles empty content gracefully', () => {
    const msg = {
        author: { bot: false },
        content: '',
        attachments: new Map()
    };
    const parsed = parseimgs(msg);
    assert.equal(parsed.length, 0);
});

test('test_t2_non_image_attachment - ignores non-image attachments', () => {
    const msg = {
        author: { bot: false },
        content: 'here is a pdf',
        attachments: new Map([
            ['att-1', { contentType: 'application/pdf', url: 'https://example.com/doc.pdf' }]
        ])
    };
    const parsed = parseimgs(msg);
    assert.equal(parsed.length, 1);
    assert.equal(typeof parsed[0].content, 'string');
    assert.equal(parsed[0].content, 'here is a pdf');
});

test('test_t2_non_image_url - keeps non-image URLs in plain text', () => {
    const msg = {
        author: { bot: false },
        content: 'check out https://google.com for info',
        attachments: new Map()
    };
    const parsed = parseimgs(msg);
    assert.equal(parsed.length, 1);
    assert.equal(typeof parsed[0].content, 'string');
    assert.equal(parsed[0].content, 'check out https://google.com for info');
});

test('test_t2_image_url_with_query_params - extracts image URL even with query params', () => {
    const msg = {
        author: { bot: false },
        content: 'image is https://example.com/pic.png?width=500&height=500#main here',
        attachments: new Map()
    };
    const parsed = parseimgs(msg);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0].content, [
        { type: 'text', text: 'image is  here' },
        { type: 'image_url', image_url: { url: 'https://example.com/pic.png?width=500&height=500#main' } }
    ]);
});

test('test_t2_image_only_message - formats image-only message without empty text part', () => {
    const msg = {
        author: { bot: false },
        content: '',
        attachments: new Map([
            ['att-1', { contentType: 'image/png', url: 'https://example.com/pic.png' }]
        ])
    };
    const parsed = parseimgs(msg);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0].content, [
        { type: 'image_url', image_url: { url: 'https://example.com/pic.png' } }
    ]);
});

test('test_t2_memory_cap_truncation - truncates memory without nesting', async () => {
    const memory = new Map();
    const messageCounts = new Map();
    
    const initialHistory = [];
    for (let i = 0; i < 25; i++) {
        initialHistory.push({ role: 'user', content: `msg ${i}` });
    }
    memory.set('ch-1', initialHistory);
    
    const message = createMockMessage({
        content: 'new message',
        bot: false,
        channelId: 'ch-1',
        memory,
        messageCounts
    });
    
    await messageStore.execute(message);
    
    const history = memory.get('ch-1');
    assert.equal(history.length, 20);
    for (const item of history) {
        assert.ok(!Array.isArray(item), 'History items must be flat objects');
        assert.equal(typeof item, 'object');
        assert.ok(item.role);
        assert.ok(item.content);
    }
});

test('test_t2_clean_debug_logs - ensure debug logging does not leak token or APIkey', async () => {
    const memory = new Map();
    memory.set('ch-1', [{ role: 'user', content: 'run autoresponse' }]);
    
    const llm = createMockOpenAI();
    const message = createMockMessage({
        channelId: 'ch-1',
        memory,
        llm
    });
    
    const originalLog = console.log;
    const originalError = console.error;
    const loggedText = [];
    
    console.log = (...args) => {
        loggedText.push(args.join(' '));
    };
    console.error = (...args) => {
        loggedText.push(args.join(' '));
    };
    
    try {
        await autoresponce.generateAutoresponce(message);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    
    const sensitiveToken = config.token;
    const sensitiveApiKey = config.APIkey;
    
    assert.ok(sensitiveToken);
    assert.ok(sensitiveApiKey);
    
    for (const log of loggedText) {
        assert.ok(!log.includes(sensitiveToken), 'Log must not contain Discord token');
        assert.ok(!log.includes(sensitiveApiKey), 'Log must not contain OpenAI API key');
    }
});

// ==========================================
// TIER 3: CROSS-FEATURE COMBINATIONS
// ==========================================

test('test_t3_mixed_attachment_and_url - extracts both attachment and plain text URL image', () => {
    const msg = {
        author: { bot: false },
        content: 'here is url https://example.com/cat.jpg and attached file',
        attachments: new Map([
            ['att-1', { contentType: 'image/png', url: 'https://example.com/dog.png' }]
        ])
    };
    
    const parsed = parseimgs(msg);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0].content, [
        { type: 'text', text: 'here is url  and attached file' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
        { type: 'image_url', image_url: { url: 'https://example.com/dog.png' } }
    ]);
});

test('test_t3_adjacent_same_role_merging - merges adjacent user messages into one', () => {
    const msgs = [
        { role: 'user', content: 'hello' },
        { role: 'user', content: [
            { type: 'image_url', image_url: { url: 'https://example.com/pic.png' } }
        ] },
        { role: 'user', content: 'world' }
    ];
    
    const parsed = parseimgs(msgs);
    assert.equal(parsed.length, 1, 'Adjacent same-role messages should be merged into 1');
    assert.deepEqual(parsed[0], {
        role: 'user',
        content: [
            { type: 'text', text: 'hello' },
            { type: 'image_url', image_url: { url: 'https://example.com/pic.png' } },
            { type: 'text', text: 'world' }
        ]
    });
});

test('test_t3_mention_large_mixed_history - retrieves last 5 messages, merges, and sends flat API payload', async () => {
    const memory = new Map();
    memory.set('ch-1', [
        { role: 'user', content: 'msg 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'msg 2' },
        { role: 'user', content: 'msg 3' },
        { role: 'assistant', content: 'reply 2' },
        { role: 'assistant', content: 'reply 3' },
        { role: 'user', content: 'msg 4' }
    ]);
    
    let capturedPayload = null;
    const llm = createMockOpenAI((payload) => {
        capturedPayload = payload;
    });
    
    const mentions = {
        has: mockFn(() => true),
        roles: new Map()
    };
    
    const message = createMockMessage({
        content: '<@bot-123> answer me',
        channelId: 'ch-1',
        memory,
        llm,
        mentions
    });
    
    await mention.execute(message);
    
    assert.ok(capturedPayload, 'API should have been called');
    assert.ok(Array.isArray(capturedPayload.messages), 'messages should be an array');
    for (const msg of capturedPayload.messages) {
        assert.equal(typeof msg, 'object');
        assert.ok(!Array.isArray(msg));
    }
});

// ==========================================
// TIER 4: REAL-WORLD APPLICATION SCENARIOS
// ==========================================

test('test_t4_full_conversation_flow - runs multi-turn conversation verifying flat memory and payloads', async () => {
    const memory = new Map();
    const messageCounts = new Map();
    let capturedPayload = null;
    const llm = createMockOpenAI((payload) => {
        capturedPayload = payload;
    });
    
    // 1. User sends message
    const msg1 = createMockMessage({
        content: 'hello bot',
        bot: false,
        channelId: 'ch-1',
        memory,
        messageCounts,
        llm
    });
    await messageStore.execute(msg1);
    
    // Verify memory after step 1
    let history = memory.get('ch-1');
    assert.equal(history.length, 1);
    assert.deepEqual(history[0], { role: 'user', content: 'hello bot' });
    
    // 2. Autoresponse triggers (force via counts)
    messageCounts.set('ch-1', 19);
    const msg2 = createMockMessage({
        content: 'trigger response',
        bot: false,
        channelId: 'ch-1',
        memory,
        messageCounts,
        llm
    });
    await messageStore.execute(msg2);
    
    assert.ok(capturedPayload);
    for (const msg of capturedPayload.messages) {
        assert.ok(!Array.isArray(msg));
    }
    
    history = memory.get('ch-1');
    assert.ok(history.length >= 2);
    assert.deepEqual(history[history.length - 1], { role: 'assistant', content: 'Hello world!' });
    
    // 3. User mentions bot with an image attachment
    capturedPayload = null;
    const mentions = {
        has: mockFn(() => true),
        roles: new Map()
    };
    const msg3 = createMockMessage({
        content: '<@bot-123> what is this?',
        bot: false,
        channelId: 'ch-1',
        memory,
        messageCounts,
        llm,
        mentions,
        attachments: [
            { contentType: 'image/png', url: 'https://cdn.discordapp.com/user_img.png' }
        ]
    });
    await mention.execute(msg3);
    
    assert.ok(capturedPayload);
    const lastSentMessage = capturedPayload.messages[capturedPayload.messages.length - 1];
    assert.equal(lastSentMessage.role, 'user');
    assert.deepEqual(lastSentMessage.content, [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: MOCK_IMAGE_DATA_URL } }
    ]);
    
    history = memory.get('ch-1');
    for (const item of history) {
        assert.ok(!Array.isArray(item));
    }
});

test('test_t4_complex_merge_flow - verifies adjacent messages of same role merge correctly with multiple images', async () => {
    const memory = new Map();
    memory.set('ch-1', [
        { role: 'user', content: 'text 1' },
        { role: 'user', content: [
            { type: 'image_url', image_url: { url: 'https://cdn.discordapp.com/pic1.png' } }
        ] },
        { role: 'user', content: 'text 2 with https://cdn.discordapp.com/pic2.png' }
    ]);
    
    let capturedPayload = null;
    const llm = createMockOpenAI((payload) => {
        capturedPayload = payload;
    });
    
    const message = createMockMessage({
        channelId: 'ch-1',
        memory,
        llm
    });
    
    await autoresponce.generateAutoresponce(message);
    
    assert.ok(capturedPayload);
    const userMessages = capturedPayload.messages.filter(m => m.role === 'user');
    assert.equal(userMessages.length, 1);
    
    assert.deepEqual(userMessages[0].content, [
        { type: 'text', text: 'text 1' },
        { type: 'image_url', image_url: { url: MOCK_IMAGE_DATA_URL } },
        { type: 'text', text: 'text 2 with ' },
        { type: 'image_url', image_url: { url: MOCK_IMAGE_DATA_URL } }
    ]);
});

test('test_t5_typing_indicator_leak_on_reply_failure - clears typing interval even if reply fails', async () => {
    const memory = new Map();
    const llm = createMockOpenAI();
    const mentions = {
        has: mockFn(() => true),
        roles: new Map()
    };
    
    const message = createMockMessage({
        content: '<@bot-123> error message',
        channelId: 'ch-1',
        memory,
        llm,
        mentions
    });
    
    message.reply = mockFn(async () => {
        throw new Error('Discord API Error');
    });

    const originalClearInterval = global.clearInterval;
    const originalSetInterval = global.setInterval;
    const originalError = console.error;
    
    let intervalId = null;
    let clearedId = null;
    
    global.setInterval = (fn, delay) => {
        const id = originalSetInterval(fn, delay);
        intervalId = id;
        return id;
    };
    
    global.clearInterval = (id) => {
        clearedId = id;
        originalClearInterval(id);
    };
    console.error = () => {};

    try {
        await mention.execute(message);
    } catch (e) {
        // Expecting no unhandled error, but even if it threw, we verify interval is cleared
    } finally {
        global.clearInterval = originalClearInterval;
        global.setInterval = originalSetInterval;
        console.error = originalError;
    }

    assert.ok(intervalId, 'typingInterval should have been started');
    assert.equal(clearedId, intervalId, 'typingInterval should have been cleared');
});

test('test_t5_duplicate_check_with_image_in_history - replaces last history message if it is an array and matches', async () => {
    const memory = new Map();
    memory.set('ch-1', [
        {
            role: 'user',
            content: [
                { type: 'text', text: '<@bot-123> help with image' },
                { type: 'image_url', image_url: { url: 'https://example.com/img.png' } }
            ]
        }
    ]);
    
    let capturedPayload = null;
    const llm = createMockOpenAI((payload) => {
        capturedPayload = payload;
    });
    
    const mentions = {
        has: mockFn(() => true),
        roles: new Map()
    };
    
    const message = createMockMessage({
        content: '<@bot-123> help with image',
        channelId: 'ch-1',
        memory,
        llm,
        mentions,
        attachments: [
            { contentType: 'image/png', url: 'https://example.com/img.png' }
        ]
    });
    
    await mention.execute(message);
    
    const history = memory.get('ch-1');
    const userMessages = history.filter(m => m.role === 'user');
    assert.equal(userMessages.length, 1, 'Should only have 1 user message in history (the replaced one)');
});
