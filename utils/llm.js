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
        return `Model \`${config?.MODEL_NAME ?? 'unknown'}\` was not found on this provider. Check MODEL_NAME.`;
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
async function requestChatCompletion(client, payload, { requestOptions, maxAttempts = 3 } = {}) {
    if (!client?.chat?.completions?.create) {
        throw new Error('LLM client is not configured.');
    }

    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const stream = await client.chat.completions.create({ ...payload, stream: true }, requestOptions);
            return { isStream: true, stream, content: '' };
        } catch (error) {
            lastError = error;
            const status = statusOf(error);
            const message = typeof error?.message === 'string' ? error.message : '';
            const isStreamingProblem = /stream|no body|unsupported/i.test(message);
            const shouldFallback = payload?.stream !== false &&
                (status === 404 || status === 405 || isStreamingProblem);

            if (shouldFallback) {
                safeLog('[LLM] Streaming rejected, retrying without streaming.');
                const response = await client.chat.completions.create(
                    { ...payload, stream: false },
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
    requestChatCompletion,
    createChatCompletionWithFallback,
    describeLlmError,
    isRetryable,
    providerHeaders,
    safeError,
};
