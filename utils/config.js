'use strict';

// Configuration resolution for the bot.
//
// Two sources, in priority order: environment variables first, then
// config.json. Environment variables matter because the bot is meant to run
// on a cloud VM (see docs/DEPLOY-ORACLE.md) where secrets arrive as env vars
// from systemd or docker-compose rather than a file on disk — but a local
// config.json still works unchanged for development.
//
// Validation stays fail-fast: a missing or blank key otherwise surfaces as a
// cryptic downstream failure (bad-token login, `undefined` model name in API
// payloads), so each entrypoint asserts everything it needs up front and
// exits with one clear message instead.

const path = require('node:path');

// Known OpenAI-compatible providers. The bot only ever speaks the OpenAI
// chat-completions dialect, so switching providers is a base-URL + model
// change, never a code change. `openwebui` is kept as a preset with no
// defaults purely so an existing config that names it still resolves.
const PROVIDER_PRESETS = {
    openrouter: {
        baseURL: 'https://openrouter.ai/api/v1',
        // Multimodal on purpose: utils/parseimgs.js inlines posted images into
        // the request, and a text-only default silently wastes that whole
        // pipeline. This one accepts images and is cheap (cents per million
        // input tokens). Model IDs churn — override with LLM_MODEL if this one
        // is retired; a 404 from the provider names the model in the error.
        model: 'qwen/qwen3.6-27b',
        label: 'OpenRouter',
    },
    groq: {
        baseURL: 'https://api.groq.com/openai/v1',
        model: 'llama-3.3-70b-versatile',
        label: 'Groq',
    },
    gemini: {
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-2.0-flash',
        label: 'Google Gemini',
    },
    cerebras: {
        baseURL: 'https://api.cerebras.ai/v1',
        model: 'llama-3.3-70b',
        label: 'Cerebras',
    },
    openai: {
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        label: 'OpenAI',
    },
    openwebui: {
        baseURL: null,
        model: null,
        label: 'OpenWebUI (self-hosted)',
    },
};

const DEFAULT_PROVIDER = 'openrouter';

// config.json key -> environment variable(s), most-preferred env name first.
// The legacy config.json names (token, APIkey, ...) are kept as-is so an
// existing local config keeps working; the env names are the conventional
// SCREAMING_SNAKE ones a deploy target expects.
const ENV_ALIASES = {
    token: ['DISCORD_TOKEN', 'TOKEN'],
    clientId: ['DISCORD_CLIENT_ID', 'CLIENT_ID'],
    guildId: ['DISCORD_GUILD_ID', 'GUILD_ID'],
    APIkey: ['LLM_API_KEY', 'OPENROUTER_API_KEY', 'API_KEY', 'APIKEY'],
    API_BASE_URL: ['LLM_BASE_URL', 'API_BASE_URL'],
    MODEL_NAME: ['LLM_MODEL', 'MODEL_NAME'],
    PROVIDER: ['LLM_PROVIDER', 'PROVIDER'],
    SYSTEM_PROMPT: ['SYSTEM_PROMPT'],
    APP_URL: ['APP_URL', 'OPENROUTER_SITE_URL'],
    APP_NAME: ['APP_NAME', 'OPENROUTER_APP_NAME'],
};

function isBlank(value) {
    return value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim() === '');
}

function missingConfigKeys(config, requiredKeys) {
    if (!config || typeof config !== 'object') return [...requiredKeys];
    return requiredKeys.filter((key) => isBlank(config[key]));
}

function assertRequiredConfig(config, requiredKeys) {
    const missing = missingConfigKeys(config, requiredKeys);
    if (missing.length > 0) {
        throw new Error(`config.json is missing required key(s): ${missing.join(', ')}`);
    }
}

// Guarded load so entrypoints can print one clear FATAL line when the file
// is absent (e.g. a container configured purely by env vars) instead of
// crashing with a raw MODULE_NOT_FOUND before validation ever runs.
function loadConfigFile(configPath = path.join(__dirname, '..', 'config.json')) {
    try {
        return require(configPath);
    } catch (e) {
        return null;
    }
}

function readEnv(key, env) {
    for (const name of ENV_ALIASES[key] || []) {
        if (!isBlank(env[name])) return env[name].trim();
    }
    return undefined;
}

// Merge env over file, then fill in whatever the chosen provider preset can
// supply. Returns null only when there is no configuration at all — neither a
// config.json nor a single recognised environment variable — so the caller
// can print the "how do I configure this" message rather than a list of
// missing keys.
function resolveConfig({ env = process.env, fileConfig, configPath } = {}) {
    const file = fileConfig !== undefined ? fileConfig : loadConfigFile(configPath);
    const resolved = { ...(file || {}) };

    for (const key of Object.keys(ENV_ALIASES)) {
        const value = readEnv(key, env);
        if (value !== undefined) resolved[key] = value;
    }

    if (!file && Object.keys(resolved).length === 0) {
        return null;
    }

    const providerName = String(resolved.PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
    const preset = PROVIDER_PRESETS[providerName];
    resolved.PROVIDER = providerName;

    // A preset only fills gaps — an explicit base URL or model always wins, so
    // pointing `openrouter` at a proxy or pinning a different model works
    // without inventing a new provider name.
    if (preset) {
        if (isBlank(resolved.API_BASE_URL) && preset.baseURL) resolved.API_BASE_URL = preset.baseURL;
        if (isBlank(resolved.MODEL_NAME) && preset.model) resolved.MODEL_NAME = preset.model;
    }

    return resolved;
}

// Back-compat: the previous API returned the raw config.json contents.
// Entrypoints now call resolveConfig(), but tests and any external caller
// that still wants the plain file keep working.
function loadConfig() {
    return resolveConfig();
}

function describeProvider(config) {
    const preset = PROVIDER_PRESETS[config?.PROVIDER];
    return preset?.label || config?.PROVIDER || 'custom';
}

module.exports = {
    missingConfigKeys,
    assertRequiredConfig,
    loadConfig,
    loadConfigFile,
    resolveConfig,
    describeProvider,
    PROVIDER_PRESETS,
    DEFAULT_PROVIDER,
    ENV_ALIASES,
};
