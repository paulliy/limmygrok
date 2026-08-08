'use strict';

// Secret-scrubbing console wrappers.
//
// Payloads and errors are logged verbosely throughout the bot, and both the
// Discord token and the LLM API key can appear inside them (an SDK error
// carries the Authorization header; a Discord error carries the token). These
// deep-scrub every argument — strings, nested objects, arrays, and Error
// stacks — before anything reaches stdout. Always use these, never raw
// console.*.
//
// This lives in its own module rather than in parseimgs.js so that both
// parseimgs.js and llm.js can depend on it without a require cycle.

const { resolveConfig } = require('./config');

// Resolved once at load: secrets come from config.json or the environment,
// and neither changes while the process runs.
let secrets = [];
try {
    const config = resolveConfig() || {};
    secrets = [
        { value: config.token, label: '[REDACTED_DISCORD_TOKEN]' },
        { value: config.APIkey, label: '[REDACTED_API_KEY]' },
    ].filter((entry) => typeof entry.value === 'string' && entry.value.trim() !== '');
} catch (e) {
    // Never let logging setup break startup; worst case nothing is scrubbed,
    // and the fail-fast config check in index.js reports the real problem.
    secrets = [];
}

function scrubString(str) {
    if (typeof str !== 'string') return str;
    let result = str;
    for (const { value, label } of secrets) {
        result = result.split(value).join(label);
    }
    return result;
}

function scrubValue(val, seen = new WeakSet()) {
    if (typeof val === 'string') {
        return scrubString(val);
    }
    if (val && typeof val === 'object') {
        if (seen.has(val)) {
            return val;
        }
        seen.add(val);

        if (val instanceof Error) {
            const scrubbedErr = new Error(scrubString(val.message));
            scrubbedErr.name = val.name;
            if (val.stack) {
                scrubbedErr.stack = scrubString(val.stack);
            }
            for (const key of Object.keys(val)) {
                scrubbedErr[key] = scrubValue(val[key], seen);
            }
            return scrubbedErr;
        }

        if (Array.isArray(val)) {
            return val.map(item => scrubValue(item, seen));
        }

        const scrubbedObj = {};
        for (const key of Object.keys(val)) {
            scrubbedObj[key] = scrubValue(val[key], seen);
        }
        return scrubbedObj;
    }
    return val;
}

function safeLog(...args) {
    console.log(...args.map(arg => scrubValue(arg)));
}

function safeError(...args) {
    console.error(...args.map(arg => scrubValue(arg)));
}

// Verbose per-message payload dumps (full conversation memory, whole API
// payloads) were useful while the bot was being built. On a shared cloud VM
// they are noise in the journal and an avoidable copy of everyone's messages,
// so they are off by default. Opt back in with DEBUG_PAYLOADS=1.
//
// Read at call time rather than cached, so the flag can be toggled at runtime
// (and by tests) without reloading the module.
function debugEnabled() {
    return process.env.DEBUG_PAYLOADS === '1';
}

function debugLog(...args) {
    if (debugEnabled()) safeLog(...args);
}

module.exports = { safeLog, safeError, debugLog, debugEnabled, scrubValue, scrubString };
