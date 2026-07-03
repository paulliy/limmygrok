const test = require('node:test');
const assert = require('node:assert/strict');

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
const { isImageUrl, parseTextAndImages, parseimgs } = require('../utils/parseimgs');
const autoresponce = require('../events/autoresponce');
const messageStore = require('../events/messageStore');
const mention = require('../events/mention');
const config = require('../config.json');

// Spy/stub helper
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
    openWebUI = null,
    mentions = null
} = {}) {
    const message = {
        author: { bot, id: 'user-456' },
        content,
        channel: {
            id: channelId,
            sendTyping: mockFn(async () => {})
        },
        client: {
            memory,
            messageCounts,
            cooldowns,
            openWebUI,
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

function createMockMentionMessage({
    content = '',
    roles = [],
    memory = new Map(),
    openWebUI = null
} = {}) {
    const mockClientUser = { id: 'bot-123', username: 'limmybot' };
    const cooldowns = new Map();
    const messageCounts = new Map();

    const mockMessage = {
        author: { bot: false, id: 'user-456' },
        content,
        channel: {
            id: 'ch-1',
            sendTyping: mockFn(async () => {})
        },
        client: {
            user: mockClientUser,
            cooldowns,
            memory,
            messageCounts,
            openWebUI
        },
        attachments: new Map(),
        mentions: {
            has: mockFn((user) => user === mockClientUser),
            roles: new Map(roles.map((r, i) => [r.id || `role-${i}`, r]))
        },
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
        })
    };
    return mockMessage;
}

// ========================================================
// 1. MALFORMED / COMPLEX URL CONFIGURATIONS
// ========================================================

test('Adversarial URLs - complex query parameters, hashes, authentication, and ports', () => {
    // Query parameters
    assert.equal(isImageUrl('https://example.com/image.png?width=200&height=100'), true);
    assert.equal(isImageUrl('https://example.com/image.png?version=1.0.0&ext=.jpg'), true);
    assert.equal(isImageUrl('https://example.com/image?format=png'), false); // pathname is /image

    // Hashes/Anchors
    assert.equal(isImageUrl('https://example.com/image.png#section-1'), true);
    assert.equal(isImageUrl('https://example.com/image.png?q=test#hash'), true);

    // Port numbers
    assert.equal(isImageUrl('http://localhost:8080/img.JPEG'), true);
    assert.equal(isImageUrl('https://127.0.0.1:9000/path/to/img.webp'), true);

    // Authentication parts
    assert.equal(isImageUrl('https://user:pass@example.com/image.gif'), true);
    assert.equal(isImageUrl('http://admin:secret@127.0.0.1:3000/image.jpg?foo=bar#baz'), true);

    // Case variations
    assert.equal(isImageUrl('https://example.com/image.WeBp'), true);
    assert.equal(isImageUrl('https://example.com/image.JPEG'), true);
    assert.equal(isImageUrl('https://example.com/image.PNG'), true);
    assert.equal(isImageUrl('https://example.com/image.Jpg'), true);
    assert.equal(isImageUrl('https://example.com/image.GIf'), true);

    // Invalid URL syntax
    assert.equal(isImageUrl('not_a_valid_url_at_all'), false);
    assert.equal(isImageUrl('http://[invalid-ip]/image.png'), false);
    assert.equal(isImageUrl(''), false);
    assert.equal(isImageUrl(null), false);
});

test('Adversarial URLs - extraction of multiple images mixed with text', () => {
    const text = 'Here is one https://example.com/first.png?w=10 and another http://user:pass@localhost:3000/second.WeBp#top! Also check this non-image link https://example.com/doc.pdf';
    const parsed = parseTextAndImages(text, []);

    assert.equal(parsed.imageUrls.length, 2);
    assert.equal(parsed.imageUrls[0], 'https://example.com/first.png?w=10');
    assert.equal(parsed.imageUrls[1], 'http://user:pass@localhost:3000/second.WeBp#top!');
    // Verify image URLs are stripped, but non-image URL is retained
    assert.equal(parsed.text.includes('https://example.com/first.png?w=10'), false);
    assert.equal(parsed.text.includes('http://user:pass@localhost:3000/second.WeBp#top!'), false);
    assert.equal(parsed.text.includes('https://example.com/doc.pdf'), true);
});

// ========================================================
// 2. EMPTY/WHITESPACE MESSAGES AND NON-IMAGE ATTACHMENTS
// ========================================================

test('Adversarial content - empty/whitespace messages should be skipped', () => {
    const emptyMsg = {
        author: { bot: false },
        content: '',
        attachments: []
    };
    const whitespaceMsg = {
        author: { bot: false },
        content: '   \n  \t  ',
        attachments: []
    };

    assert.deepEqual(parseimgs(emptyMsg), []);
    assert.deepEqual(parseimgs(whitespaceMsg), []);
});

test('Adversarial content - non-image attachments should be ignored', () => {
    const msgWithPdf = {
        author: { bot: false },
        content: '',
        attachments: [
            { contentType: 'application/pdf', url: 'https://example.com/report.pdf' },
            { contentType: 'text/plain', url: 'https://example.com/todo.txt' }
        ]
    };

    assert.deepEqual(parseimgs(msgWithPdf), []);

    // Mixed non-image and image attachment
    const mixedAttachments = {
        author: { bot: false },
        content: 'some text',
        attachments: [
            { contentType: 'application/pdf', url: 'https://example.com/report.pdf' },
            { contentType: 'image/png', url: 'https://example.com/photo.png' }
        ]
    };

    const parsedMixed = parseimgs(mixedAttachments);
    assert.equal(parsedMixed.length, 1);
    assert.deepEqual(parsedMixed[0].content, [
        { type: 'text', text: 'some text' },
        { type: 'image_url', image_url: { url: 'https://example.com/photo.png' } }
    ]);
});

test('Adversarial content - malformed attachment structure should handle gracefully', () => {
    const badMsg1 = {
        author: { bot: false },
        content: 'test',
        attachments: null
    };
    const badMsg2 = {
        author: { bot: false },
        content: 'test',
        attachments: [null, undefined, { url: 'https://foo.com/bar.png' }] // no contentType
    };

    const parsed1 = parseimgs(badMsg1);
    assert.equal(parsed1.length, 1);
    assert.equal(parsed1[0].content, 'test');

    const parsed2 = parseimgs(badMsg2);
    assert.equal(parsed2.length, 1);
    assert.equal(parsed2[0].content, 'test');
});

// ========================================================
// 3. LARGE COUNTS OF CONSECUTIVE SAME-ROLE MESSAGES
// ========================================================

test('Stress - 1000 consecutive same-role text messages deep merging', () => {
    const messages = Array.from({ length: 1000 }, (_, i) => ({
        role: 'user',
        content: `message ${i}`
    }));

    const start = Date.now();
    const result = parseimgs(messages);
    const duration = Date.now() - start;

    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    
    const expectedContent = messages.map(m => m.content).join('\n');
    assert.equal(result[0].content, expectedContent);
    assert.ok(duration < 200, `Execution took too long: ${duration}ms`);
});

test('Stress - 500 consecutive same-role mixed messages (text & images) merging', () => {
    const messages = [];
    for (let i = 0; i < 500; i++) {
        if (i % 2 === 0) {
            messages.push({
                role: 'user',
                content: `text part ${i}`
            });
        } else {
            messages.push({
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: `https://example.com/img${i}.png` } }
                ]
            });
        }
    }

    const start = Date.now();
    const result = parseimgs(messages);
    const duration = Date.now() - start;

    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.ok(Array.isArray(result[0].content));
    assert.equal(result[0].content.length, 500);

    for (let i = 0; i < 500; i++) {
        if (i % 2 === 0) {
            assert.deepEqual(result[0].content[i], { type: 'text', text: `text part ${i}` });
        } else {
            assert.deepEqual(result[0].content[i], {
                type: 'image_url',
                image_url: { url: `https://example.com/img${i}.png` }
            });
        }
    }

    assert.ok(duration < 200, `Execution took too long: ${duration}ms`);
});

test('Stress - verify immutability of input messages during merge', () => {
    const msg1 = {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }]
    };
    const msg2 = {
        role: 'user',
        content: [{ type: 'text', text: 'world' }]
    };

    const result1 = parseimgs([msg1, msg2]);
    
    assert.deepEqual(msg1.content, [{ type: 'text', text: 'hello' }]);
    assert.deepEqual(msg2.content, [{ type: 'text', text: 'world' }]);
    
    const result2 = parseimgs([msg1, msg2]);
    assert.deepEqual(result1, result2);
});

// ========================================================
// 4. BOT MENTION PARSING EDGE CASES
// ========================================================

test('Mention parsing - bot mention mixed in other words', async () => {
    const memory = new Map();
    const msg = createMockMentionMessage({
        content: 'prefix<@bot-123>suffix',
        memory
    });
    
    const openWebUI = {
        chat: {
            completions: {
                create: mockFn(async () => {
                    return (async function* () {
                        yield { choices: [{ delta: { content: 'hello' } }] };
                    })();
                })
            }
        }
    };
    msg.client.openWebUI = openWebUI;

    await mention.execute(msg);

    const storedHistory = memory.get('ch-1');
    assert.ok(storedHistory);
    assert.equal(storedHistory[0].role, 'user');
    assert.equal(storedHistory[0].content, 'prefixsuffix');
});

test('Mention parsing - double mentions', async () => {
    const memory = new Map();
    const msg = createMockMentionMessage({
        content: '<@bot-123> hello <@!bot-123>',
        memory
    });

    const openWebUI = {
        chat: {
            completions: {
                create: mockFn(async () => {
                    return (async function* () {
                        yield { choices: [{ delta: { content: 'hello' } }] };
                    })();
                })
            }
        }
    };
    msg.client.openWebUI = openWebUI;

    await mention.execute(msg);

    const storedHistory = memory.get('ch-1');
    assert.ok(storedHistory);
    assert.equal(storedHistory[0].content, 'hello');
});

test('Mention parsing - role mentions matching username are stripped, other roles kept', async () => {
    const memory = new Map();
    const msg = createMockMentionMessage({
        content: '<@&role-matching> <@&role-other> test',
        roles: [
            { id: 'role-matching', name: 'limmybot' },
            { id: 'role-other', name: 'another-role' }
        ],
        memory
    });

    const openWebUI = {
        chat: {
            completions: {
                create: mockFn(async () => {
                    return (async function* () {
                        yield { choices: [{ delta: { content: 'hello' } }] };
                    })();
                })
            }
        }
    };
    msg.client.openWebUI = openWebUI;

    await mention.execute(msg);

    const storedHistory = memory.get('ch-1');
    assert.ok(storedHistory);
    assert.equal(storedHistory[0].content, '<@&role-other> test');
});

test('Mention parsing - no content other than mention replies with error', async () => {
    const memory = new Map();
    const msg = createMockMentionMessage({
        content: '<@bot-123>    <@!bot-123>',
        memory
    });

    await mention.execute(msg);

    assert.equal(memory.get('ch-1'), undefined);
    assert.equal(msg.reply.mock.calls.length, 1);
    assert.equal(msg.reply.mock.calls[0].arguments[0], 'Ask me smth chud...');
});

// ========================================================
// 5. LOG SCRUBBING
// ========================================================

test('Log scrubbing - normal operations do not leak secrets', async () => {
    const memory = new Map([
        ['ch-1', [{ role: 'user', content: 'test message' }]]
    ]);
    const openWebUI = {
        chat: {
            completions: {
                create: mockFn(async () => {
                    return (async function* () {
                        yield { choices: [{ delta: { content: 'hello' } }] };
                    })();
                })
            }
        }
    };
    const message = createMockMessage({
        content: 'trigger response',
        channelId: 'ch-1',
        memory,
        openWebUI
    });
    
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    
    console.log = (...args) => {
        logs.push(args.map(arg => arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg)).join(' '));
    };
    console.error = (...args) => {
        logs.push(args.map(arg => arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg)).join(' '));
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
    
    for (const log of logs) {
        assert.ok(!log.includes(sensitiveToken), 'Log must not contain Discord token');
        assert.ok(!log.includes(sensitiveApiKey), 'Log must not contain OpenAI API key');
    }
});

test('Log scrubbing - user message containing Discord token is redacted', async () => {
    const memory = new Map();
    const msg = createMockMessage({
        content: `Check this token: ${config.token}`,
        memory
    });

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => {
        logs.push(args.map(arg => arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg)).join(' '));
    };

    try {
        await messageStore.execute(msg);
    } finally {
        console.log = originalLog;
    }

    const hasRedacted = logs.some(log => log.includes('[REDACTED_DISCORD_TOKEN]'));
    const hasLeak = logs.some(log => log.includes(config.token));
    
    assert.ok(hasRedacted, 'Discord token should be redacted in logs');
    assert.ok(!hasLeak, 'Discord token should not be present in logs');
});

test('Log scrubbing - OpenAI error leaking API key in stack/message is redacted', async () => {
    const memory = new Map();
    const msg = createMockMessage({
        content: 'trigger response',
        memory
    });
    memory.set('ch-1', [{ role: 'user', content: 'hello' }]);
    msg.client.messageCounts.set('ch-1', 19); // 19 + 1 = 20, triggers auto-response

    const openWebUI = {
        chat: {
            completions: {
                create: mockFn(async () => {
                    const err = new Error('Connection failed');
                    err.stack = `Error: Connection failed\n at OpenAI.request (apiKey=${config.APIkey})`;
                    throw err;
                })
            }
        }
    };
    msg.client.openWebUI = openWebUI;

    const errorLogs = [];
    const originalError = console.error;
    console.error = (...args) => {
        errorLogs.push(args.map(arg => arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg)).join(' '));
    };

    try {
        await messageStore.execute(msg);
    } catch (e) {
        // execute catches errors internally
    } finally {
        console.error = originalError;
    }

    const hasRedacted = errorLogs.some(log => log.includes('[REDACTED_API_KEY]'));
    const hasLeak = errorLogs.some(log => log.includes(config.APIkey));
    
    assert.ok(hasRedacted, 'OpenAI API key should be redacted in error logs');
    assert.ok(!hasLeak, 'OpenAI API key should not be present in error logs');
});
