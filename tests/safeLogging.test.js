// Guards that command errors are logged through the secret-scrubbing logger
// (utils/log.js) rather than a raw console.error.

const test = require('node:test');
const assert = require('node:assert/strict');

function mockFn() {
    const fn = function (...args) {
        fn.calls.push(args);
    };
    fn.calls = [];
    return fn;
}

test('interactionCreate logs a missing command through safeError', async () => {
    const safeError = mockFn();
    const log = require('../utils/log');
    const original = log.safeError;
    const interactionCreatePath = require.resolve('../events/interactionCreate');

    // The handler destructures safeError at require time, so the stub has to be
    // in place *before* it loads — patching the module object afterwards would
    // not reach the captured binding.
    log.safeError = safeError;
    delete require.cache[interactionCreatePath];
    const interactionCreate = require('../events/interactionCreate');

    try {
        await interactionCreate.execute({
            isChatInputCommand: () => true,
            commandName: 'missing-command',
            client: {
                commands: new Map(),
                cooldowns: new Map(),
            },
        });

        assert.equal(safeError.calls.length, 1);
        assert.match(String(safeError.calls[0][0]), /No command matching/);
    } finally {
        // Restore, and drop the handler compiled against the stub so later
        // tests get the real logger back.
        log.safeError = original;
        delete require.cache[interactionCreatePath];
    }
});
