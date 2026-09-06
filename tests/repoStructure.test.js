const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class MockCollection extends Map {}

class MockSlashCommandBuilder {
    constructor() {
        this.name = '';
        this.description = '';
    }

    setName(name) {
        this.name = name;
        return this;
    }

    setDescription(description) {
        this.description = description;
        return this;
    }

    addIntegerOption(configure) {
        configure(new MockOptionBuilder());
        return this;
    }

    addStringOption(configure) {
        configure(new MockOptionBuilder());
        return this;
    }

    addChannelOption(configure) {
        configure(new MockOptionBuilder());
        return this;
    }

    addSubcommand(configure) {
        configure(new MockSubcommandBuilder());
        return this;
    }

    setDefaultMemberPermissions() { return this; }
    setDMPermission() { return this; }

    toJSON() {
        return {
            name: this.name,
            description: this.description,
        };
    }
}

class MockSubcommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addChannelOption(configure) {
        configure(new MockOptionBuilder());
        return this;
    }
}

class MockOptionBuilder {
    setName() { return this; }
    setDescription() { return this; }
    setRequired() { return this; }
    setMinValue() { return this; }
    setMaxValue() { return this; }
    addChannelTypes() { return this; }
}

require.cache[require.resolve('discord.js')] = {
    id: require.resolve('discord.js'),
    filename: require.resolve('discord.js'),
    loaded: true,
    exports: {
        Collection: MockCollection,
        Events: {
            ClientReady: 'ready',
            InteractionCreate: 'interactionCreate',
            MessageCreate: 'messageCreate',
            GuildCreate: 'guildCreate',
        },
        MessageFlags: {
            Ephemeral: 64,
        },
        PermissionFlagsBits: {
            ManageGuild: 32n,
        },
        ChannelType: {
            GuildText: 0,
        },
        SlashCommandBuilder: MockSlashCommandBuilder,
    }
};

const repoRoot = path.resolve(__dirname, '..');

function getFiles(directory, predicate = () => true) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...getFiles(fullPath, predicate));
        } else if (entry.isFile() && predicate(fullPath)) {
            files.push(fullPath);
        }
    }

    return files;
}

test('all command files export slash-command data and an execute function', () => {
    const commandFiles = getFiles(path.join(repoRoot, 'commands'), file => file.endsWith('.js'));
    assert.ok(commandFiles.length > 0, 'expected at least one command file');

    const commandNames = new Set();
    for (const file of commandFiles) {
        delete require.cache[file];
        const command = require(file);

        assert.equal(typeof command.execute, 'function', `${file} should export execute`);
        assert.ok(command.data, `${file} should export data`);
        assert.equal(typeof command.data.name, 'string', `${file} should set command data name`);
        assert.notEqual(command.data.name.trim(), '', `${file} should not have a blank command name`);
        assert.equal(commandNames.has(command.data.name), false, `${file} duplicates command name ${command.data.name}`);
        commandNames.add(command.data.name);
    }
});

// index.js registers a file in events/ only when it exports BOTH `name` and
// `execute`, and warns when it exports exactly one. So the rule worth
// asserting is structural — both or neither — rather than a hand-maintained
// list of which filenames are allowed to be helpers, which had to be edited
// every time a module moved and said nothing about correctness.
test('every module in events/ exports both a handler name and execute, or neither', () => {
    const eventFiles = getFiles(path.join(repoRoot, 'events'), file => file.endsWith('.js'));
    assert.ok(eventFiles.length > 0, 'expected some event modules');

    let handlers = 0;
    for (const file of eventFiles) {
        delete require.cache[file];
        const eventModule = require(file);
        const basename = path.basename(file);

        const hasName = Boolean(eventModule.name);
        const hasExecute = typeof eventModule.execute === 'function';

        assert.equal(hasName, hasExecute,
            `${basename} exports ${hasName ? 'name without execute' : 'execute without name'} — index.js would skip it with a warning`);

        if (hasName) {
            handlers += 1;
            assert.equal(typeof eventModule.name, 'string', `${basename} should export a string event name`);
            assert.notEqual(eventModule.name.trim(), '', `${basename} should not have a blank event name`);
        }
    }

    assert.ok(handlers > 0, 'expected at least one real event handler in events/');
});

test('configuration exposes the values required by the bot runtime', () => {
    const config = require('../config.json');
    for (const key of ['token', 'clientId', 'guildId', 'APIkey', 'API_BASE_URL', 'MODEL_NAME']) {
        assert.equal(typeof config[key], 'string', `config.${key} should be a string`);
        assert.notEqual(config[key].trim(), '', `config.${key} should not be blank`);
    }
});
