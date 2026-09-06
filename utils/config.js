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
        // A sparse MoE with 13B active parameters: fast and very cheap, which
        // is what a bot writing one-line replies all day actually needs. It is
        // text-only, hence the separate visionModel below.
        model: 'deepseek/deepseek-v4-flash-0731',
        // Used only for the requests that actually carry an image.
        //
        // Its headline $0.03/M input rate applies below 32K tokens and jumps
        // to $0.20/M above that. The bot stays far under: the system prompt,
        // a handful of turns and an inlined image come to a few thousand
        // tokens. Worth remembering before widening the history window.
        //
        // Floating alias — pin qwen/qwen3.7-flash-20260727 to freeze the
        // revision.
        visionModel: 'qwen/qwen3.7-flash',
        label: 'OpenRouter',
    },
    groq: {
        baseURL: 'https://api.groq.com/openai/v1',
        model: 'llama-3.3-70b-versatile',
        visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
        label: 'Groq',
    },
    gemini: {
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        // Natively multimodal, so one model covers both cases.
        model: 'gemini-2.0-flash',
        visionModel: 'gemini-2.0-flash',
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
        visionModel: 'gpt-4o-mini',
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
    VISION_MODEL: ['LLM_VISION_MODEL', 'VISION_MODEL'],
    PROVIDER: ['LLM_PROVIDER', 'PROVIDER'],
    SYSTEM_PROMPT: ['SYSTEM_PROMPT'],
    APP_URL: ['APP_URL', 'OPENROUTER_SITE_URL'],
    APP_NAME: ['APP_NAME', 'OPENROUTER_APP_NAME'],
    // Privacy controls sent with every OpenRouter request (utils/llm.js
    // applies these; see PRIVACY_BOOLEAN_KEYS below for the defaults).
    DENY_TRAINING: ['LLM_DENY_TRAINING', 'DENY_TRAINING'],
    ZDR: ['LLM_ZDR', 'ZDR'],
};

// Config keys that are booleans, and what they default to when nothing sets
// them. Both privacy flags default ON: the point of a bot that is supposed to
// hold a server's private conversation is that the answer to "will this train
// someone else's model" is no by default, not opt-in.
const PRIVACY_BOOLEAN_KEYS = {
    DENY_TRAINING: true,
    ZDR: true,
};

function isBlank(value) {
    return value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim() === '');
}

// Accepts a real boolean (config.json can hold one), the usual env-var truthy
// strings, or nothing — in which case the caller's default applies.
function parseBooleanFlag(value, defaultValue) {
    if (typeof value === 'boolean') return value;
    if (isBlank(value)) return defaultValue;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function missingConfigKeys(config, requiredKeys) {
    if (!config || typeof config !== 'object') return [...requiredKeys];
    return requiredKeys.filter((key) => isBlank(config[key]));
}

function assertRequiredConfig(config, requiredKeys) {
    const missing = missingConfigKeys(config, requiredKeys);
    if (missing.length > 0) {
        // Deliberately does not say "config.json": the environment is the
        // primary path now (see docs/DEPLOY-ORACLE.md), and naming a file the
        // deployer may not even have sends them looking in the wrong place.
        throw new Error(`Configuration is missing required key(s): ${missing.join(', ')}`);
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

    // Normalize once here so every downstream reader (utils/llm.js, index.js,
    // the fallbackConfig in each event handler) sees a real boolean rather
    // than re-parsing "0"/"false"/undefined itself.
    for (const [key, defaultValue] of Object.entries(PRIVACY_BOOLEAN_KEYS)) {
        resolved[key] = parseBooleanFlag(resolved[key], defaultValue);
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
        if (isBlank(resolved.VISION_MODEL) && preset.visionModel) resolved.VISION_MODEL = preset.visionModel;
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
    parseBooleanFlag,
    PROVIDER_PRESETS,
    PRIVACY_BOOLEAN_KEYS,
    DEFAULT_PROVIDER,
    ENV_ALIASES,
};
