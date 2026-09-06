// Tests for utils/triggers.js — deciding when someone is talking *to* the bot
// rather than near it. Both MessageCreate listeners divide ownership on this
// answer, so a wrong result means either a double reply or silence.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    isMentioned,
    isReplyToBot,
    mentionsBotName,
    isDirectlyAddressed,
    addressReason,
    aliasesFor,
} = require('../utils/triggers');

const BOT_ID = 'bot-123';

function createMessage({
    content = '',
    mentionedUserIds = [],
    repliedUserId = null,
    authorIsBot = false,
    aliases,
} = {}) {
    return {
        content,
        author: { id: 'user-1', bot: authorIsBot },
        client: {
            user: { id: BOT_ID, username: 'limmygrok' },
            config: aliases ? { BOT_ALIASES: aliases } : {},
        },
        mentions: {
            users: new Map(mentionedUserIds.map((id) => [id, { id }])),
            repliedUser: repliedUserId ? { id: repliedUserId } : null,
        },
    };
}

test('an @mention of the bot is a direct address', () => {
    const message = createMessage({ content: '<@bot-123> what is going on', mentionedUserIds: [BOT_ID] });
    assert.equal(isMentioned(message), true);
    assert.equal(isDirectlyAddressed(message), true);
    assert.equal(addressReason(message), 'mention');
});

test('a mention of someone else is not', () => {
    const message = createMessage({ content: '<@other> hi', mentionedUserIds: ['other'] });
    assert.equal(isMentioned(message), false);
    assert.equal(isDirectlyAddressed(message), false);
    assert.equal(addressReason(message), null);
});

test('replying to the bot counts even when the ping is suppressed', () => {
    // Discord still resolves the replied-to author, which is how a silent
    // reply is caught.
    const message = createMessage({ content: 'thats wrong', repliedUserId: BOT_ID });
    assert.equal(isMentioned(message), false);
    assert.equal(isReplyToBot(message), true);
    assert.equal(addressReason(message), 'reply');
});

test('replying to another person is not a direct address', () => {
    const message = createMessage({ content: 'agreed', repliedUserId: 'someone-else' });
    assert.equal(isReplyToBot(message), false);
    assert.equal(isDirectlyAddressed(message), false);
});

test('using the bot name as a word counts', () => {
    assert.equal(mentionsBotName(createMessage({ content: 'limmygrok what do you think' })), true);
    assert.equal(mentionsBotName(createMessage({ content: 'ask limmygrok, he knows' })), true);
    assert.equal(mentionsBotName(createMessage({ content: 'LIMMYGROK!!' })), true);
});

test('the name must be a whole word, not a substring', () => {
    assert.equal(mentionsBotName(createMessage({ content: 'limmygrokking is not a word' })), false);
    assert.equal(mentionsBotName(createMessage({ content: 'xlimmygrok' })), false);
});

test('configured aliases are honoured alongside the username', () => {
    const message = createMessage({ content: 'oi gene you there', aliases: 'gene, limmy' });
    assert.equal(mentionsBotName(message), true);
    assert.ok(aliasesFor(message.client).includes('gene'));
    assert.ok(aliasesFor(message.client).includes('limmygrok'), 'username is always an alias');
});

test('very short aliases are ignored to avoid firing on common words', () => {
    const message = createMessage({ content: 'ok so anyway', aliases: 'ok' });
    assert.equal(mentionsBotName(message), false);
});

test('messages from bots are never treated as a direct address', () => {
    const message = createMessage({ content: 'limmygrok hello', authorIsBot: true, mentionedUserIds: [BOT_ID] });
    assert.equal(isDirectlyAddressed(message), false);
});

test('ordinary chatter is left to the ambient path', () => {
    const message = createMessage({ content: 'anyone up for ranked later' });
    assert.equal(isDirectlyAddressed(message), false);
    assert.equal(addressReason(message), null);
});

test('trigger checks are safe on malformed messages', () => {
    assert.equal(isDirectlyAddressed(null), false);
    assert.equal(isDirectlyAddressed({}), false);
    assert.equal(isMentioned({ client: {} }), false);
    assert.equal(mentionsBotName({ content: null, client: { user: { username: 'limmygrok' } } }), false);
});
