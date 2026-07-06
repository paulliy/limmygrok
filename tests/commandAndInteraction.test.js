const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const realConsoleLog = console.log;
const realConsoleError = console.error;

beforeEach(() => {
    console.log = () => {};
    console.error = () => {};
});

afterEach(() => {
    console.log = realConsoleLog;
    console.error = realConsoleError;
});

class MockCollection extends Map {}

class MockSlashCommandBuilder {
    constructor() {
        this.name = '';
        this.description = '';
        this.options = [];
    }

    setName(name) {
        this.name = name;
        return this;
    }

    setDescription(description) {
        this.description = description;
        return this;
    }

    setDefaultMemberPermissions(perms) {
        this.defaultMemberPermissions = perms;
        return this;
    }

    setDMPermission(dm) {
        this.dmPermission = dm;
        return this;
    }

    addIntegerOption(configure) {
        const option = new MockOptionBuilder('integer');
        configure(option);
        this.options.push(option);
        return this;
    }

    addStringOption(configure) {
        const option = new MockOptionBuilder('string');
        configure(option);
        this.options.push(option);
        return this;
    }

    toJSON() {
        return {
            name: this.name,
            description: this.description,
            options: this.options,
        };
    }
}

class MockOptionBuilder {
    constructor(type) {
        this.type = type;
    }

    setName(name) {
        this.name = name;
        return this;
    }

    setDescription(description) {
        this.description = description;
        return this;
    }

    setRequired(required) {
        this.required = required;
        return this;
    }

    setMinValue(minValue) {
        this.minValue = minValue;
        return this;
    }

    setMaxValue(maxValue) {
        this.maxValue = maxValue;
        return this;
    }
}

require.cache[require.resolve('discord.js')] = {
    id: require.resolve('discord.js'),
    filename: require.resolve('discord.js'),
    loaded: true,
    exports: {
        Collection: MockCollection,
        Events: {
            InteractionCreate: 'interactionCreate',
            MessageCreate: 'messageCreate',
        },
        MessageFlags: {
            Ephemeral: 64,
        },
        PermissionFlagsBits: {
            ManageGuild: 32n,
        },
        SlashCommandBuilder: MockSlashCommandBuilder,
    }
};

for (const modulePath of [
    '../events/interactionCreate',
    '../commands/utilities/setautoresponcerate',
    '../commands/utilities/autoresponseinfo',
]) {
    delete require.cache[require.resolve(modulePath)];
}

const interactionCreate = require('../events/interactionCreate');
const setAutoResponseRateCommand = require('../commands/utilities/setautoresponcerate');
const autoResponseInfoCommand = require('../commands/utilities/autoresponseinfo');

function mockFn(implementation) {
    const fn = async function(...args) {
        fn.calls.push(args);
        if (implementation) {
            return implementation(...args);
        }
    };
    fn.calls = [];
    return fn;
}

function createInteraction({
    commandName = 'test',
    isChatInputCommand = true,
    userId = 'user-1',
    command = null,
    cooldowns = new MockCollection(),
    channelId = 'channel-1',
    messageCounts = new Map(),
    autoResponseRates = new Map(),
    getInteger = () => 10,
    replied = false,
    deferred = false,
    inGuild = true,
    hasManageGuild = true,
} = {}) {
    const commands = new MockCollection();
    if (command) {
        commands.set(commandName, command);
    }

    return {
        commandName,
        replied,
        deferred,
        user: { id: userId },
        channel: channelId ? { id: channelId } : null,
        client: {
            commands,
            cooldowns,
            messageCounts,
            autoResponseRates,
        },
        options: {
            getInteger,
        },
        isChatInputCommand: () => isChatInputCommand,
        inGuild: () => inGuild,
        memberPermissions: {
            has: (permission) => hasManageGuild
        },
        reply: mockFn(),
        followUp: mockFn(),
    };
}

test('interactionCreate ignores non-chat-input interactions', async () => {
    const command = {
        data: { name: 'ignored' },
        execute: mockFn(),
    };
    const interaction = createInteraction({
        commandName: 'ignored',
        isChatInputCommand: false,
        command,
    });

    await interactionCreate.execute(interaction);

    assert.equal(command.execute.calls.length, 0);
    assert.equal(interaction.reply.calls.length, 0);
});

test('interactionCreate executes registered commands and creates cooldown buckets', async () => {
    const command = {
        data: { name: 'ping' },
        cooldown: 0,
        execute: mockFn(),
    };
    const interaction = createInteraction({
        commandName: 'ping',
        command,
    });

    await interactionCreate.execute(interaction);

    assert.equal(command.execute.calls.length, 1);
    assert.ok(interaction.client.cooldowns.has('ping'));
});

test('interactionCreate blocks users who are still on command cooldown', async () => {
    const cooldowns = new MockCollection([
        ['ping', new MockCollection([['user-1', Date.now()]])]
    ]);
    const command = {
        data: { name: 'ping' },
        cooldown: 30,
        execute: mockFn(),
    };
    const interaction = createInteraction({
        commandName: 'ping',
        command,
        cooldowns,
    });

    await interactionCreate.execute(interaction);

    assert.equal(command.execute.calls.length, 0);
    assert.equal(interaction.reply.calls.length, 1);
    assert.match(interaction.reply.calls[0][0].content, /cooldown/);
});

test('interactionCreate replies when command execution fails before deferral', async () => {
    const command = {
        data: { name: 'explode' },
        cooldown: 0,
        execute: mockFn(async () => {
            throw new Error('boom');
        }),
    };
    const interaction = createInteraction({
        commandName: 'explode',
        command,
    });

    await interactionCreate.execute(interaction);

    assert.equal(interaction.reply.calls.length, 1);
    assert.equal(interaction.followUp.calls.length, 0);
    assert.match(interaction.reply.calls[0][0].content, /error/i);
});

test('interactionCreate follows up when command execution fails after deferral', async () => {
    const command = {
        data: { name: 'explode-late' },
        cooldown: 0,
        execute: mockFn(async () => {
            throw new Error('late boom');
        }),
    };
    const interaction = createInteraction({
        commandName: 'explode-late',
        command,
        deferred: true,
    });

    await interactionCreate.execute(interaction);

    assert.equal(interaction.reply.calls.length, 0);
    assert.equal(interaction.followUp.calls.length, 1);
    assert.match(interaction.followUp.calls[0][0].content, /error/i);
});

test('setautoresponcerate stores a channel-specific rate', async () => {
    const interaction = createInteraction({
        getInteger: () => 7,
    });

    await setAutoResponseRateCommand.execute(interaction);

    assert.equal(interaction.client.autoResponseRates.get('channel-1'), 7);
    assert.equal(interaction.reply.calls.length, 1);
    assert.match(interaction.reply.calls[0][0].content, /every 7 messages/);
});

test('setautoresponcerate rejects invalid rates defensively', async () => {
    const interaction = createInteraction({
        getInteger: () => 0,
    });

    await setAutoResponseRateCommand.execute(interaction);

    assert.equal(interaction.client.autoResponseRates.has('channel-1'), false);
    assert.equal(interaction.reply.calls.length, 1);
    assert.match(interaction.reply.calls[0][0].content, /between 1 and 100/);
});

test('setautoresponcerate rejects non-channel interactions', async () => {
    const interaction = createInteraction({
        channelId: null,
        getInteger: () => 7,
    });

    await setAutoResponseRateCommand.execute(interaction);

    assert.equal(interaction.reply.calls.length, 1);
    assert.match(interaction.reply.calls[0][0].content, /text channel/);
});

test('autoresponseinfo reports rate, current count, and remaining messages', async () => {
    const interaction = createInteraction({
        messageCounts: new Map([['channel-1', 5]]),
        autoResponseRates: new Map([['channel-1', 8]]),
    });

    await autoResponseInfoCommand.execute(interaction);

    assert.equal(interaction.reply.calls.length, 1);
    assert.match(interaction.reply.calls[0][0].content, /due in 3 messages/);
    assert.match(interaction.reply.calls[0][0].content, /Current rate: every 8 messages/);
    assert.match(interaction.reply.calls[0][0].content, /Current count: 5/);
});

test('autoresponseinfo rejects non-channel interactions', async () => {
    const interaction = createInteraction({
        channelId: null,
    });

    await autoResponseInfoCommand.execute(interaction);

    assert.equal(interaction.reply.calls.length, 1);
    assert.match(interaction.reply.calls[0][0].content, /text channel/);
});
