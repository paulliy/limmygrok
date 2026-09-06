// Tests for provider/config resolution (utils/config.js) and the LLM request
// wrapper's retry, fallback and error-description behaviour (utils/llm.js).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const realConsoleLog = console.log;
const realConsoleError = console.error;
beforeEach(() => { console.log = () => {}; console.error = () => {}; });
afterEach(() => { console.log = realConsoleLog; console.error = realConsoleError; });

const { resolveConfig, describeProvider, PROVIDER_PRESETS } = require('../utils/config');
const { requestChatCompletion, describeLlmError, isRetryable, providerHeaders } = require('../utils/llm');

// --- configuration -----------------------------------------------------------

test('provider preset fills in base URL and model when unset', () => {
    const config = resolveConfig({ env: {}, fileConfig: { token: 't', APIkey: 'k', PROVIDER: 'openrouter' } });
    assert.equal(config.API_BASE_URL, PROVIDER_PRESETS.openrouter.baseURL);
    assert.equal(config.MODEL_NAME, PROVIDER_PRESETS.openrouter.model);
});

test('OpenRouter is the default provider when none is named', () => {
    const config = resolveConfig({ env: {}, fileConfig: { token: 't', APIkey: 'k' } });
    assert.equal(config.PROVIDER, 'openrouter');
    assert.equal(config.API_BASE_URL, 'https://openrouter.ai/api/v1');
});

test('explicit base URL and model always beat the preset', () => {
    const config = resolveConfig({
        env: {},
        fileConfig: { PROVIDER: 'groq', API_BASE_URL: 'http://proxy.local/v1', MODEL_NAME: 'pinned-model' },
    });
    assert.equal(config.API_BASE_URL, 'http://proxy.local/v1');
    assert.equal(config.MODEL_NAME, 'pinned-model');
});

test('environment variables override config.json', () => {
    const config = resolveConfig({
        env: { DISCORD_TOKEN: 'env-token', LLM_MODEL: 'env-model' },
        fileConfig: { token: 'file-token', MODEL_NAME: 'file-model', APIkey: 'k' },
    });
    assert.equal(config.token, 'env-token');
    assert.equal(config.MODEL_NAME, 'env-model');
    // Untouched file keys survive.
    assert.equal(config.APIkey, 'k');
});

test('blank environment variables do not shadow real config values', () => {
    const config = resolveConfig({
        env: { DISCORD_TOKEN: '   ' },
        fileConfig: { token: 'file-token' },
    });
    assert.equal(config.token, 'file-token');
});

test('env-only configuration works with no config.json at all', () => {
    const config = resolveConfig({
        env: { DISCORD_TOKEN: 't', LLM_API_KEY: 'k', OPENROUTER_API_KEY: 'ignored' },
        fileConfig: null,
    });
    assert.equal(config.token, 't');
    assert.equal(config.APIkey, 'k', 'the first alias listed wins');
    assert.equal(config.MODEL_NAME, PROVIDER_PRESETS.openrouter.model);
});

test('no file and no environment resolves to null', () => {
    assert.equal(resolveConfig({ env: {}, fileConfig: null }), null);
});

test('an unknown provider name is kept without inventing defaults', () => {
    const config = resolveConfig({ env: {}, fileConfig: { PROVIDER: 'mystery', API_BASE_URL: 'http://x/v1', MODEL_NAME: 'm' } });
    assert.equal(config.PROVIDER, 'mystery');
    assert.equal(describeProvider(config), 'mystery');
});

test('OpenRouter attribution headers are sent only for OpenRouter', () => {
    const headers = providerHeaders({ PROVIDER: 'openrouter', APP_URL: 'https://example.com', APP_NAME: 'limmygrok' });
    assert.equal(headers['HTTP-Referer'], 'https://example.com');
    assert.equal(headers['X-Title'], 'limmygrok');
    assert.equal(providerHeaders({ PROVIDER: 'groq' }), undefined);
});

// --- request wrapper ---------------------------------------------------------

function stubClient(handler) {
    let calls = 0;
    return {
        calls: () => calls,
        chat: { completions: { create: async (payload, options) => handler(++calls, payload, options) } },
    };
}

function httpError(status, message = 'boom') {
    const error = new Error(message);
    error.status = status;
    return error;
}

test('a successful streaming request is returned as a stream', async () => {
    const client = stubClient(() => ({ marker: 'stream' }));
    const result = await requestChatCompletion(client, { model: 'm', messages: [] });
    assert.equal(result.isStream, true);
    assert.equal(result.stream.marker, 'stream');
});

test('retries a 429 and succeeds on a later attempt', async () => {
    const client = stubClient((call) => {
        if (call === 1) throw httpError(429);
        return { marker: 'ok' };
    });
    const result = await requestChatCompletion(client, { model: 'm', messages: [] });
    assert.equal(result.isStream, true);
    assert.equal(client.calls(), 2);
});

test('gives up after maxAttempts and rethrows the provider error', async () => {
    const client = stubClient(() => { throw httpError(503); });
    await assert.rejects(
        () => requestChatCompletion(client, { model: 'm', messages: [] }, { maxAttempts: 2 }),
        /boom/
    );
    assert.equal(client.calls(), 2);
});

test('does not retry an auth failure', async () => {
    const client = stubClient(() => { throw httpError(401); });
    await assert.rejects(() => requestChatCompletion(client, { model: 'm', messages: [] }));
    assert.equal(client.calls(), 1, '401 must not be retried');
});

test('falls back to a non-streaming request when streaming is rejected', async () => {
    const client = stubClient((call, payload) => {
        if (payload.stream === true) throw httpError(405, 'streaming unsupported');
        return { choices: [{ message: { content: 'plain reply' } }] };
    });
    const result = await requestChatCompletion(client, { model: 'm', messages: [] });
    assert.equal(result.isStream, false);
    assert.equal(result.content, 'plain reply');
});

test('isRetryable covers rate limits, 5xx and network errors only', () => {
    assert.equal(isRetryable(httpError(429)), true);
    assert.equal(isRetryable(httpError(500)), true);
    assert.equal(isRetryable(httpError(400)), false);
    assert.equal(isRetryable(httpError(403)), false);
    const network = new Error('socket hang up');
    network.code = 'ECONNRESET';
    assert.equal(isRetryable(network), true);
});

test('describeLlmError explains the failure instead of dumping provider JSON', () => {
    assert.match(describeLlmError(httpError(401), { PROVIDER: 'openrouter' }), /API key/i);
    assert.match(describeLlmError(httpError(402), { PROVIDER: 'openrouter' }), /credit/i);
    assert.match(describeLlmError(httpError(404), { PROVIDER: 'openrouter', MODEL_NAME: 'some/model' }), /some\/model/);
    assert.match(describeLlmError(httpError(500), {}), /provider/i);

    // The OpenRouter free tier's daily cap is the most likely 429 in practice,
    // so its message says so rather than "try again".
    const rateLimited = describeLlmError(httpError(429), { PROVIDER: 'openrouter' });
    assert.match(rateLimited, /50\/day|free models/i);
    assert.match(describeLlmError(httpError(429), { PROVIDER: 'groq' }), /Rate limited/i);
});

test('an unconfigured client fails with a clear message', async () => {
    await assert.rejects(() => requestChatCompletion(null, {}), /not configured/i);
    await assert.rejects(() => requestChatCompletion({}, {}), /not configured/i);
});

// --- model routing -----------------------------------------------------------

const { pickModel, messagesContainImages } = require('../utils/llm');

const ROUTED = { MODEL_NAME: 'text-model', VISION_MODEL: 'vision-model' };
const TEXT_TURN = { role: 'user', content: 'who whiffed' };
const IMAGE_TURN = {
    role: 'user',
    content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ],
};

test('image detection only fires on an actual image part', () => {
    assert.equal(messagesContainImages([TEXT_TURN]), false);
    assert.equal(messagesContainImages([TEXT_TURN, IMAGE_TURN]), true);
    // A content array with no image part is still text.
    assert.equal(messagesContainImages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), false);
    assert.equal(messagesContainImages(null), false);
    assert.equal(messagesContainImages([]), false);
});

test('ordinary chat uses the cheap text model', () => {
    assert.equal(pickModel(ROUTED, [TEXT_TURN]), 'text-model');
});

test('a request carrying an image is routed to the vision model', () => {
    assert.equal(pickModel(ROUTED, [TEXT_TURN, IMAGE_TURN]), 'vision-model');
});

test('without a vision model configured, images still go somewhere', () => {
    assert.equal(pickModel({ MODEL_NAME: 'only-model' }, [IMAGE_TURN]), 'only-model');
});

test('the OpenRouter preset supplies both models', () => {
    const config = resolveConfig({ env: {}, fileConfig: { token: 't', APIkey: 'k' } });
    assert.equal(config.MODEL_NAME, PROVIDER_PRESETS.openrouter.model);
    assert.equal(config.VISION_MODEL, PROVIDER_PRESETS.openrouter.visionModel);
    assert.notEqual(config.MODEL_NAME, config.VISION_MODEL, 'the cheap default is text-only');
});

test('the vision model can be overridden independently', () => {
    const config = resolveConfig({ env: { LLM_VISION_MODEL: 'my/vision' }, fileConfig: { token: 't', APIkey: 'k' } });
    assert.equal(config.VISION_MODEL, 'my/vision');
    assert.equal(config.MODEL_NAME, PROVIDER_PRESETS.openrouter.model, 'text model is untouched');
});

// --- privacy: deny-training / zero data retention -----------------------------

const { parseBooleanFlag, PRIVACY_BOOLEAN_KEYS } = require('../utils/config');
const { privacyProviderOptions } = require('../utils/llm');

test('privacy flags default on with no configuration at all', () => {
    const config = resolveConfig({ env: {}, fileConfig: { token: 't', APIkey: 'k' } });
    assert.equal(config.DENY_TRAINING, true);
    assert.equal(config.ZDR, true);
});

test('privacy flags can be turned off via env, in either the LLM_-prefixed or bare name', () => {
    const a = resolveConfig({ env: { LLM_DENY_TRAINING: '0', ZDR: 'false' }, fileConfig: { token: 't', APIkey: 'k' } });
    assert.equal(a.DENY_TRAINING, false);
    assert.equal(a.ZDR, false);
});

test('a real boolean in config.json is honoured, not stringified', () => {
    const config = resolveConfig({ env: {}, fileConfig: { token: 't', APIkey: 'k', ZDR: false } });
    assert.equal(config.ZDR, false);
});

test('parseBooleanFlag: common truthy/falsy spellings, and default on blank', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) {
        assert.equal(parseBooleanFlag(truthy, false), true, truthy);
    }
    for (const falsy of ['0', 'false', 'FALSE', 'no', 'off']) {
        assert.equal(parseBooleanFlag(falsy, true), false, falsy);
    }
    assert.equal(parseBooleanFlag(undefined, true), true);
    assert.equal(parseBooleanFlag('', false), false);
    assert.equal(parseBooleanFlag(true, false), true, 'a real boolean passes through');
});

test('both privacy keys default true — the point is opt-out, not opt-in', () => {
    assert.deepEqual(PRIVACY_BOOLEAN_KEYS, { DENY_TRAINING: true, ZDR: true });
});

test('privacyProviderOptions denies training and requires ZDR by default, OpenRouter only', () => {
    const options = privacyProviderOptions({ PROVIDER: 'openrouter', DENY_TRAINING: true, ZDR: true });
    assert.deepEqual(options, { data_collection: 'deny', zdr: true });

    // Every other provider either has its own dashboard-level controls or
    // doesn't understand this field — sending it would be a no-op at best.
    assert.equal(privacyProviderOptions({ PROVIDER: 'groq' }), undefined);
    assert.equal(privacyProviderOptions({ PROVIDER: 'gemini' }), undefined);
    assert.equal(privacyProviderOptions(undefined), undefined);
});

test('privacyProviderOptions reflects an explicit opt-out', () => {
    assert.deepEqual(
        privacyProviderOptions({ PROVIDER: 'openrouter', DENY_TRAINING: false, ZDR: false }),
        { data_collection: 'allow', zdr: false }
    );
});

test('requestChatCompletion actually sends the privacy fields to OpenRouter', async () => {
    let seenPayload;
    const client = stubClient((call, payload) => {
        seenPayload = payload;
        return { marker: 'stream' };
    });

    await requestChatCompletion(client, { model: 'm', messages: [] }, {
        config: { PROVIDER: 'openrouter', DENY_TRAINING: true, ZDR: true },
    });

    assert.deepEqual(seenPayload.provider, { data_collection: 'deny', zdr: true });
});

test('an explicit payload.provider from the caller is not overwritten', async () => {
    let seenPayload;
    const client = stubClient((call, payload) => {
        seenPayload = payload;
        return { marker: 'stream' };
    });

    await requestChatCompletion(client, { model: 'm', messages: [], provider: { order: ['fireworks'] } }, {
        config: { PROVIDER: 'openrouter', DENY_TRAINING: true, ZDR: true },
    });

    assert.deepEqual(seenPayload.provider, { order: ['fireworks'] });
});

test('no config passed means no privacy fields are added — back-compat for old callers', async () => {
    let seenPayload;
    const client = stubClient((call, payload) => { seenPayload = payload; return { marker: 'stream' }; });
    await requestChatCompletion(client, { model: 'm', messages: [] });
    assert.equal('provider' in seenPayload, false);
});

test('privacy fields still apply to the non-streaming fallback request', async () => {
    let seenNonStreamingPayload;
    const client = stubClient((call, payload) => {
        if (payload.stream === true) throw httpError(405, 'streaming unsupported');
        seenNonStreamingPayload = payload;
        return { choices: [{ message: { content: 'ok' } }] };
    });

    await requestChatCompletion(client, { model: 'm', messages: [] }, {
        config: { PROVIDER: 'openrouter', DENY_TRAINING: true, ZDR: true },
    });

    assert.deepEqual(seenNonStreamingPayload.provider, { data_collection: 'deny', zdr: true });
});
