'use strict';

// Fail-fast validation for config.json. A missing or blank key otherwise
// surfaces as a cryptic downstream failure (bad-token login, `undefined`
// model name in API payloads), so each entrypoint asserts everything it
// needs up front and exits with one clear message instead.

function missingConfigKeys(config, requiredKeys) {
    if (!config || typeof config !== 'object') return [...requiredKeys];
    return requiredKeys.filter((key) => {
        const value = config[key];
        return value === undefined ||
            value === null ||
            (typeof value === 'string' && value.trim() === '');
    });
}

function assertRequiredConfig(config, requiredKeys) {
    const missing = missingConfigKeys(config, requiredKeys);
    if (missing.length > 0) {
        throw new Error(`config.json is missing required key(s): ${missing.join(', ')}`);
    }
}

// Guarded load so entrypoints can print one clear FATAL line when the file
// is absent (e.g. a container without the bind-mount) instead of crashing
// with a raw MODULE_NOT_FOUND before validation ever runs.
function loadConfig() {
    try {
        return require('../config.json');
    } catch (e) {
        return null;
    }
}

module.exports = { missingConfigKeys, assertRequiredConfig, loadConfig };
