const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_AUTO_RESPONSE_RATE,
  getAutoResponseRate,
  setAutoResponseRate,
  getMessagesUntilNextAutoResponse,
  resetAutoResponseCount,
} = require('../utils/autoResponseState');

test('uses the default auto-response rate when no override exists', () => {
  const client = {};

  assert.equal(getAutoResponseRate(client, 'channel-1'), DEFAULT_AUTO_RESPONSE_RATE);
  assert.equal(getMessagesUntilNextAutoResponse(client, 'channel-1'), DEFAULT_AUTO_RESPONSE_RATE);
});

test('computes remaining messages correctly and updates channel overrides', () => {
  const client = {
    messageCounts: new Map([['channel-1', 5]]),
  };

  assert.equal(getMessagesUntilNextAutoResponse(client, 'channel-1'), 15);

  setAutoResponseRate(client, 'channel-1', 5);
  assert.equal(getAutoResponseRate(client, 'channel-1'), 5);
  assert.equal(getMessagesUntilNextAutoResponse(client, 'channel-1'), 5);
});

test('resets the channel count when the auto-response threshold is reached', () => {
  const client = {
    messageCounts: new Map([['channel-1', 5]]),
  };

  resetAutoResponseCount(client, 'channel-1');

  assert.equal(client.messageCounts.get('channel-1'), 0);
});
