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

test('event files are either Discord event handlers or known helper modules', () => {
    const eventFiles = getFiles(path.join(repoRoot, 'events'), file => file.endsWith('.js'));
    const helperFiles = new Set([
        'autoresponce.js',
        'autoResponseState.js',
        'channelSettings.js',
    ]);

    for (const file of eventFiles) {
        delete require.cache[file];
        const eventModule = require(file);
        const basename = path.basename(file);

        if (helperFiles.has(basename)) {
            assert.equal(Boolean(eventModule.name && eventModule.execute), false, `${basename} should remain a helper module`);
            continue;
        }

        assert.equal(typeof eventModule.name, 'string', `${basename} should export an event name`);
        assert.notEqual(eventModule.name.trim(), '', `${basename} should not have a blank event name`);
        assert.equal(typeof eventModule.execute, 'function', `${basename} should export execute`);
    }
});

test('configuration exposes the values required by the bot runtime', () => {
    const config = require('../config.json');
    for (const key of ['token', 'clientId', 'guildId', 'APIkey', 'API_BASE_URL', 'MODEL_NAME']) {
        assert.equal(typeof config[key], 'string', `config.${key} should be a string`);
        assert.notEqual(config[key].trim(), '', `config.${key} should not be blank`);
    }
});
