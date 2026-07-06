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

module.exports = { missingConfigKeys, assertRequiredConfig };
