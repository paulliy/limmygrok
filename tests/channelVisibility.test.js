// Tests for the channel-visibility feature:
//  - messageStore's ambient path is gated by the allowlist
//  - direct @mentions are NOT gated (always reply)
//  - the /channels command add/remove/list/clear + permission gating

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const realConsoleLog = console.log;
const realConsoleError = console.error;
const realStdoutWrite = process.stdout.write;

beforeEach(() => {
    console.log = () => {};
    console.error = () => {};
    process.stdout.write = () => true;
});

afterEach(() => {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    process.stdout.write = realStdoutWrite;
});

// A discord.js mock complete enough to build the /channels SlashCommandBuilder
// at require-time and to drive the message event handlers.
class MockCollection extends Map {}

class MockOptionBuilder {
    setName() { return this; }
    setDescription() { return this; }
    setRequired() { return this; }
    addChannelTypes() { return this; }
}
class MockSubcommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addChannelOption(configure) { configure(new MockOptionBuilder()); return this; }
}
class MockSlashCommandBuilder {
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    setDefaultMemberPermissions() { return this; }
    setDMPermission() { return this; }
    addSubcommand(configure) { configure(new MockSubcommandBuilder()); return this; }
    toJSON() { return { name: this.name, description: this.description }; }
}

require.cache[require.resolve('discord.js')] = {
    id: require.resolve('discord.js'),
    filename: require.resolve('discord.js'),
    loaded: true,
    exports: {
        Collection: MockCollection,
        Events: { MessageCreate: 'messageCreate', GuildCreate: 'guildCreate' },
        MessageFlags: { Ephemeral: 64 },
        PermissionFlagsBits: { ManageGuild: 32n },
        ChannelType: { GuildText: 0 },
        SlashCommandBuilder: MockSlashCommandBuilder,
    },
};

const messageStore = require('../events/messageStore');
const mention = require('../events/mention');
const channelsCommand = require('../commands/utilities/channels');
const { isChannelAllowed } = require('../events/channelSettings');

function streamingOpenAI() {
    return {
        chat: { completions: { create: async () => (async function* () {
            yield { choices: [{ delta: { content: 'hi' } }] };
        })() } },
    };
}

function createMessage({ content = 'hello', channelId = 'ch-1', allowedChannels = new Map(), mentionsBot = false, openWebUI = null }) {
    const memory = new Map();
    const messageCounts = new Map();
    const botUser = { id: 'bot-123', username: 'limmybot' };
    const replyCalls = [];
    return {
        memory,
        replyCalls,
        message: {
            author: { bot: false, id: 'user-456' },
            content,
            channel: { id: channelId, sendTyping: async () => {} },
            attachments: new Map(),
            client: { memory, messageCounts, cooldowns: new Map(), allowedChannels, openWebUI, user: botUser },
            mentions: { has: () => mentionsBot, roles: new Map() },
            reply: async (c) => {
                replyCalls.push(c);
                const m = { content: c, edit: async (n) => { m.content = n; return m; }, delete: async () => {} };
                return m;
            },
        },
    };
}

// ---- Gating -----------------------------------------------------------------

test('messageStore ignores a non-mention message in a channel that is not allowlisted', async () => {
    const { message, memory } = createMessage({ channelId: 'ch-1', allowedChannels: new Map() });
    await messageStore.execute(message);
    assert.equal(memory.get('ch-1'), undefined, 'nothing should be stored for a disallowed channel');
});

test('messageStore stores a non-mention message in an allowlisted channel', async () => {
    const allowed = new Map([['ch-1', 'guild-1']]);
    const { message, memory } = createMessage({ content: 'hello', channelId: 'ch-1', allowedChannels: allowed });
    await messageStore.execute(message);
    const history = memory.get('ch-1');
    assert.ok(history, 'memory should exist for an allowed channel');
    assert.equal(history.length, 1);
    assert.deepEqual(history[0], { role: 'user', content: 'hello' });
});

test('a direct @mention still replies even in a channel that is NOT allowlisted', async () => {
    const { message, memory, replyCalls } = createMessage({
        content: '<@bot-123> hey',
        channelId: 'ch-1',
        allowedChannels: new Map(), // empty: channel not allowed
        mentionsBot: true,
        openWebUI: streamingOpenAI(),
    });
    await mention.execute(message);
    assert.ok(replyCalls.length > 0, 'mention should have replied despite the channel not being allowlisted');
    assert.ok(memory.get('ch-1'), 'mention manages its own memory for the channel');
});

// ---- /channels command ------------------------------------------------------

function createInteraction({ subcommand, channelOption = null, channelId = 'ch-1', guildId = 'guild-1', canManage = true }) {
    const allowedChannels = new Map();
    const replies = [];
    return {
        allowedChannels,
        replies,
        interaction: {
            client: { allowedChannels },
            guildId,
            channel: { id: channelId },
            inGuild: () => true,
            memberPermissions: { has: () => canManage },
            options: {
                getSubcommand: () => subcommand,
                getChannel: () => channelOption,
            },
            reply: async (payload) => { replies.push(payload); },
        },
    };
}

test('/channels add enables the current channel', async () => {
    const { interaction, allowedChannels, replies } = createInteraction({ subcommand: 'add', channelId: 'ch-9' });
    await channelsCommand.execute(interaction);
    assert.equal(allowedChannels.has('ch-9'), true);
    assert.match(replies[0].content, /enabled/i);
});

test('/channels remove disables a channel', async () => {
    const { interaction, allowedChannels, replies } = createInteraction({ subcommand: 'remove', channelId: 'ch-9' });
    allowedChannels.set('ch-9', 'guild-1');
    await channelsCommand.execute(interaction);
    assert.equal(allowedChannels.has('ch-9'), false);
    assert.match(replies[0].content, /disabled/i);
});

test('/channels list reports this guild\'s allowed channels', async () => {
    const { interaction, allowedChannels, replies } = createInteraction({ subcommand: 'list' });
    allowedChannels.set('ch-1', 'guild-1');
    allowedChannels.set('ch-2', 'guild-1');
    allowedChannels.set('ch-3', 'guild-other');
    await channelsCommand.execute(interaction);
    assert.match(replies[0].content, /<#ch-1>/);
    assert.match(replies[0].content, /<#ch-2>/);
    assert.ok(!replies[0].content.includes('ch-3'), 'other guilds are not listed');
});

test('/channels clear removes only this guild\'s channels', async () => {
    const { interaction, allowedChannels, replies } = createInteraction({ subcommand: 'clear' });
    allowedChannels.set('ch-1', 'guild-1');
    allowedChannels.set('ch-3', 'guild-other');
    await channelsCommand.execute(interaction);
    assert.equal(allowedChannels.has('ch-1'), false);
    assert.equal(allowedChannels.has('ch-3'), true);
    assert.match(replies[0].content, /Cleared/);
});

test('/channels refuses a caller without Manage Server', async () => {
    const { interaction, allowedChannels, replies } = createInteraction({ subcommand: 'add', channelId: 'ch-9', canManage: false });
    await channelsCommand.execute(interaction);
    assert.equal(allowedChannels.has('ch-9'), false, 'no change when unauthorized');
    assert.match(replies[0].content, /Manage Server/);
});
