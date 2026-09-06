const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');

const { resolveImageUrlsToBase64 } = require('../utils/parseimgs');
const { requestChatCompletion } = require('../utils/llm');

const realConsoleLog = console.log;
const realConsoleError = console.error;
const realLookup = dns.promises.lookup;

beforeEach(() => {
    console.log = () => {};
    console.error = () => {};
    dns.promises.lookup = async (hostname) => {
        return [{ address: '8.8.8.8', family: 4 }];
    };
});

afterEach(() => {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    dns.promises.lookup = realLookup;
});

test('falls back to non-streaming chat completion when streaming is rejected', async () => {
    let calls = [];
    const client = {
        chat: {
            completions: {
                create: async (payload) => {
                    calls.push(payload);
                    if (payload.stream) {
                        const error = new Error('400 status code (no body)');
                        error.status = 400;
                        throw error;
                    }

                    return {
                        choices: [{ message: { content: 'fallback reply' } }]
                    };
                }
            }
        }
    };

    const result = await requestChatCompletion(client, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true
    });

    assert.equal(calls.length, 2);
    assert.equal(result.isStream, false);
    assert.equal(result.content, 'fallback reply');
});

test('does not retry non-streaming when a 400 is not stream-related', async () => {
    let calls = [];
    const client = {
        chat: {
            completions: {
                create: async (payload) => {
                    calls.push(payload);
                    const error = new Error('invalid image_url.url');
                    error.status = 400;
                    throw error;
                }
            }
        }
    };

    await assert.rejects(
        requestChatCompletion(client, {
            model: 'test-model',
            messages: [{ role: 'user', content: 'hello' }],
            stream: true
        }),
        /invalid image_url\.url/
    );

    assert.equal(calls.length, 1);
});

test('resolves downloaded images to data URLs instead of bare base64', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        headers: {
            get: (name) => name.toLowerCase() === 'content-type' ? 'image/png' : null,
        },
        arrayBuffer: async () => Buffer.from('abc'),
    });

    try {
        const resolved = await resolveImageUrlsToBase64([{
            role: 'user',
            content: [{
                type: 'image_url',
                image_url: { url: 'https://cdn.discordapp.com/example.png' }
            }]
        }]);

        assert.equal(resolved[0].content[0].image_url.url, 'data:image/png;base64,YWJj');
    } finally {
        global.fetch = originalFetch;
    }
});

test('keeps existing image data URLs intact', async () => {
    const dataUrl = 'data:image/jpeg;base64,AAAA';
    const resolved = await resolveImageUrlsToBase64([{
        role: 'user',
        content: [{
            type: 'image_url',
            image_url: { url: dataUrl }
        }]
    }]);

    assert.equal(resolved[0].content[0].image_url.url, dataUrl);
});
