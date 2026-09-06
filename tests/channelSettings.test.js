const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isChannelAllowed,
    allowChannel,
    disallowChannel,
    listAllowedChannels,
    clearAllowedChannels,
} = require('../utils/channelSettings');

test('channels are not allowed by default (opt-in)', () => {
    const client = {};
    assert.equal(isChannelAllowed(client, 'ch-1'), false);
    assert.equal(isChannelAllowed(client, undefined), false);
});

test('allowChannel enables a channel and disallowChannel disables it', () => {
    const client = { allowedChannels: new Map() };

    allowChannel(client, 'ch-1', 'guild-1');
    assert.equal(isChannelAllowed(client, 'ch-1'), true);

    assert.equal(disallowChannel(client, 'ch-1'), true);
    assert.equal(isChannelAllowed(client, 'ch-1'), false);
    assert.equal(disallowChannel(client, 'ch-1'), false, 'removing a missing channel returns false');
});

test('allowChannel requires a channel id', () => {
    const client = { allowedChannels: new Map() };
    assert.throws(() => allowChannel(client, '', 'guild-1'), /channel ID is required/);
});

test('listAllowedChannels is scoped to a guild', () => {
    const client = { allowedChannels: new Map() };
    allowChannel(client, 'ch-1', 'guild-1');
    allowChannel(client, 'ch-2', 'guild-1');
    allowChannel(client, 'ch-3', 'guild-2');

    assert.deepEqual(listAllowedChannels(client, 'guild-1').sort(), ['ch-1', 'ch-2']);
    assert.deepEqual(listAllowedChannels(client, 'guild-2'), ['ch-3']);
    assert.deepEqual(listAllowedChannels(client, 'guild-unknown'), []);
    assert.deepEqual(listAllowedChannels(client).sort(), ['ch-1', 'ch-2', 'ch-3'], 'no guild = all');
});

test('clearAllowedChannels only removes the given guild\'s channels', () => {
    const client = { allowedChannels: new Map() };
    allowChannel(client, 'ch-1', 'guild-1');
    allowChannel(client, 'ch-2', 'guild-1');
    allowChannel(client, 'ch-3', 'guild-2');

    const removed = clearAllowedChannels(client, 'guild-1');
    assert.equal(removed, 2);
    assert.equal(isChannelAllowed(client, 'ch-1'), false);
    assert.equal(isChannelAllowed(client, 'ch-2'), false);
    assert.equal(isChannelAllowed(client, 'ch-3'), true, 'other guilds untouched');
});
