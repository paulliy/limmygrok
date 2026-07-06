'use strict';

// bun test preload (wired up in bunfig.toml). Several test files require
// ../config.json — directly and via events/mention.js etc. — which crashes
// the whole suite in a clean environment: fresh clone, CI, a Docker build
// stage. Real secrets must never exist in those environments, so when no
// config.json is present, write an obviously-dummy one before any test
// module loads. No-op when a real config.json exists (local dev).
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
        token: 'ci-dummy-token',
        clientId: '000000000000000000',
        guildId: '000000000000000000',
        APIkey: 'ci-dummy-apikey',
        API_BASE_URL: 'http://localhost:9/v1',
        MODEL_NAME: 'ci-dummy-model',
    }, null, 2) + '\n');
    console.log('[tests/preload] no config.json found — wrote a dummy one for the test run');
}
