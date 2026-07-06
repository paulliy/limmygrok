const test = require('node:test');
const assert = require('node:assert/strict');

function mockFn() {
    const fn = function(...args) {
        fn.calls.push(args);
    };
    fn.calls = [];
    return fn;
}

test('interactionCreate uses safeError for missing-command logging', async () => {
    const safeError = mockFn();
    const parseimgsPath = require.resolve('../utils/parseimgs');
    const interactionCreatePath = require.resolve('../events/interactionCreate');

    const parseimgs = require('../utils/parseimgs');
    parseimgs.safeError = safeError;

    delete require.cache[interactionCreatePath];
    const interactionCreate = require('../events/interactionCreate');

    const interaction = {
        isChatInputCommand: () => true,
        commandName: 'missing-command',
        client: {
            commands: new Map(),
            cooldowns: new Map()
        }
    };

    await interactionCreate.execute(interaction);

    assert.equal(safeError.calls.length, 1);
    assert.match(String(safeError.calls[0][0]), /No command matching/);
});
