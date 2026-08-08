'use strict';

// The LLM client, and the request wrapper every reply path goes through.
//
// The bot talks one dialect — OpenAI chat-completions — so the provider is a
// base URL plus a model name (see utils/config.js). This module owns the two
// things that are provider-specific in practice: the extra headers OpenRouter
// wants for attribution, and turning a provider's rate-limit / transient
// failures into either a retry or one clear user-facing sentence.

const { OpenAI } = require('openai');
// Deliberately utils/log.js and not utils/parseimgs.js: parseimgs re-exports
// this module, so importing it back would be a require cycle and the logging
// helpers would arrive undefined.
const { safeLog, safeError } = require('./log');

// OpenRouter attributes usage to an app via HTTP-Referer (the identifier) and
// X-Title (the display name). Both are optional; sending them just means the
// bot shows up as itself rather than as anonymous traffic.
function providerHeaders(config) {
    if (config?.PROVIDER !== 'openrouter') return undefined;
    const headers = {};
    if (config.APP_URL) headers['HTTP-Referer'] = config.APP_URL;
    headers['X-Title'] = config.APP_NAME || 'limmygrok';
    return headers;
}

// OpenRouter can route the same model name to several backing hosts (e.g.
// DeepSeek's own API, or a third party serving the same open weights), and
// which one gets picked is not otherwise under this bot's control. This is
// the enforcement half of that: a per-request `provider` object OpenRouter
// reads before routing.
//   - data_collection: 'deny' refuses any backing provider that stores or
//     trains on the request at all.
//   - zdr: true is stricter still — only providers with a genuine Zero Data
//     Retention policy are eligible, not just ones that promise not to train.
// Both default on (utils/config.js) because a bot built to hold a server's
// private conversation should not need an opt-in for that. Only meaningful
// for OpenRouter — other providers don't understand this field, so it is
// scoped the same way providerHeaders() scopes its headers.
//
// Trade-off worth knowing: this narrows which backing hosts are eligible for
// a given model, and in principle a request could find zero eligible hosts
// and error. If that happens the error surfaces to the user rather than
// failing silently; relax it with LLM_DENY_TRAINING=0 / LLM_ZDR=0 if a
// specific model has no compliant host.
function privacyProviderOptions(config) {
    if (config?.PROVIDER !== 'openrouter') return undefined;
    return {
        data_collection: config.DENY_TRAINING === false ? 'allow' : 'deny',
        zdr: config.ZDR !== false,
    };
}

function createLlmClient(config) {
    return new OpenAI({
        apiKey: config.APIkey,
        baseURL: config.API_BASE_URL,
        defaultHeaders: providerHeaders(config),
        // The SDK's own retries are disabled: requestChatCompletion below
        // retries with jitter and knows which failures are worth retrying.
        maxRetries: 0,
        timeout: 120_000,
    });
}

// True when any turn actually carries an image. Content is either a plain
// string or an array of {type:'text'|'image_url'} parts (see
// utils/parseimgs.js), so only the array form can hold one.
function messagesContainImages(messages) {
    if (!Array.isArray(messages)) return false;
    return messages.some((message) =>
        Array.isArray(message?.content) &&
        message.content.some((part) => part?.type === 'image_url'));
}

// Picks the model for one request.
//
// The everyday model is chosen for speed and price, which for the cheapest
// good options means text-only. Rather than paying multimodal rates on every
// "who whiffed", the vision model is swapped in only for the requests that
// actually contain an image. Providers whose main model is already multimodal
// set both to the same ID, so this is a no-op for them.
function pickModel(config, messages) {
    if (!messagesContainImages(messages)) return config?.MODEL_NAME;
    return config?.VISION_MODEL || config?.MODEL_NAME;
}

function statusOf(error) {
    return error?.status || error?.statusCode || error?.response?.status;
}

// 429 (rate limited) and 5xx (provider hiccup) are worth another attempt;
// 401/403 (bad key) and 400 (bad payload) never are.
function isRetryable(error) {
    const status = statusOf(error);
    if (status === 429) return true;
    if (typeof status === 'number' && status >= 500) return true;
    // Network-level failures surface without a status.
    const code = error?.code || error?.cause?.code;
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}

// Providers report the retry delay in different places; fall back to
// exponential backoff with jitter when none is given.
function retryDelayMs(error, attempt) {
    const header = error?.headers?.['retry-after'] ?? error?.response?.headers?.get?.('retry-after');
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 30_000);
    }
    const base = Math.min(1000 * 2 ** attempt, 8000);
    return base + Math.floor(Math.random() * 250);
}

// Turns a provider error into something worth showing in Discord. The raw
// message is often a wall of JSON, and on OpenRouter a 429 usually means the
// free-tier daily cap rather than a momentary burst — worth saying plainly so
// the fix is obvious.
function describeLlmError(error, config) {
    const status = statusOf(error);
    if (status === 401 || status === 403) {
        return 'My API key was rejected. Check the key in the bot config.';
    }
    if (status === 429) {
        return config?.PROVIDER === 'openrouter'
            ? 'Rate limited by OpenRouter — free models allow 20 requests/minute and 50/day on an unfunded account. Try again later, or add credit / switch to a paid model.'
            : 'Rate limited by the model provider. Try again in a bit.';
    }
    if (status === 402) {
        return 'The model provider says this account is out of credit.';
    }
    if (status === 404) {
        // Two models are configured (text and vision), and the failing request
        // could have used either, so name both rather than guessing.
        const configured = [config?.MODEL_NAME, config?.VISION_MODEL]
            .filter(Boolean)
            .filter((name, index, all) => all.indexOf(name) === index)
            .map((name) => `\`${name}\``)
            .join(' or ');
        return `Model not found on this provider (${configured || 'none configured'}). Check LLM_MODEL / LLM_VISION_MODEL — model IDs get retired.`;
    }
    if (typeof status === 'number' && status >= 500) {
        return 'The model provider is having a moment (5xx). Try again shortly.';
    }
    const message = typeof error?.message === 'string' ? error.message : '';
    return message.slice(0, 300) || 'Something went wrong talking to the model.';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tries a streaming completion, retrying retryable failures, and falls back to
// a non-streaming request when the provider rejects streaming outright
// (404/405, or an error that names streaming). Returns {isStream:true, stream}
// or {isStream:false, response} — callers branch on isStream.
async function requestChatCompletion(client, payload, { requestOptions, maxAttempts = 3, config } = {}) {
    if (!client?.chat?.completions?.create) {
        throw new Error('LLM client is not configured.');
    }

    // Applied here rather than at each of the three call sites, so passing
    // `config` through is the only thing a caller has to remember — there is
    // one chokepoint every reply goes through, and this is it. An explicit
    // `payload.provider` (a caller opting into something specific) still wins.
    const privacy = privacyProviderOptions(config);
    const basePayload = privacy ? { provider: privacy, ...payload } : payload;

    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const stream = await client.chat.completions.create({ ...basePayload, stream: true }, requestOptions);
            return { isStream: true, stream, content: '' };
        } catch (error) {
            lastError = error;
            const status = statusOf(error);
            const message = typeof error?.message === 'string' ? error.message : '';
            const isStreamingProblem = /stream|no body|unsupported/i.test(message);
            const shouldFallback = basePayload?.stream !== false &&
                (status === 404 || status === 405 || isStreamingProblem);

            if (shouldFallback) {
                safeLog('[LLM] Streaming rejected, retrying without streaming.');
                const response = await client.chat.completions.create(
                    { ...basePayload, stream: false },
                    requestOptions
                );
                return {
                    isStream: false,
                    response,
                    content: response?.choices?.[0]?.message?.content || '',
                };
            }

            if (attempt < maxAttempts - 1 && isRetryable(error)) {
                const delay = retryDelayMs(error, attempt);
                safeLog(`[LLM] ${status ?? 'network'} error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts}).`);
                await sleep(delay);
                continue;
            }

            throw error;
        }
    }

    throw lastError;
}

// Back-compat shim for the previous name/signature.
async function createChatCompletionWithFallback(client, payload, requestOptions) {
    return requestChatCompletion(client, payload, { requestOptions });
}

module.exports = {
    createLlmClient,
    pickModel,
    messagesContainImages,
    privacyProviderOptions,
    requestChatCompletion,
    createChatCompletionWithFallback,
    describeLlmError,
    isRetryable,
    providerHeaders,
    safeError,
};
