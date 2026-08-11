// Require the necessary discord.js classes
const { Client, Events, GatewayIntentBits, Collection, MessageFlags} = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { safeLog, safeError } = require('./utils/log');
const { openDatabase, PersistentMap } = require('./utils/db');
const { pruneStatsEvents } = require('./utils/stats');
const { assertRequiredConfig, resolveConfig, describeProvider } = require('./utils/config');
const { createLlmClient } = require('./utils/llm');

// Fail fast with one clear message instead of a cryptic downstream error
// (bad-token login, `undefined` model in API payloads). Configuration comes
// from environment variables first, then config.json — see utils/config.js.
// API_BASE_URL and MODEL_NAME are normally supplied by the provider preset,
// so in practice only a token and an API key are mandatory.
const config = resolveConfig();
if (!config) {
    safeError('[FATAL] No configuration found. Set DISCORD_TOKEN and LLM_API_KEY in the environment, or provide a config.json next to index.js.');
    process.exit(1);
}
try {
    assertRequiredConfig(config, ['token', 'APIkey', 'API_BASE_URL', 'MODEL_NAME']);
} catch (error) {
    safeError(`[FATAL] ${error.message}`);
    safeError('[FATAL] Set them as environment variables (DISCORD_TOKEN, LLM_API_KEY, LLM_MODEL) or in config.json.');
    process.exit(1);
}
const { token } = config;
// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);
// When the client is ready, run this code (only once).
// The distinction between `client: Client<boolean>` and `readyClient: Client<true>` is important for TypeScript developers.
// The distinction between `client: Client` and `readyClient: Client<true>` is important for TypeScript developers.
// It makes some properties non-nullable.
client.commands = new Collection();

// SQLite-backed state: conversation memory, per-channel message counts, and
// auto-response rate settings all survive restarts. PersistentMap has the same
// get/set interface as the Collections/Maps it replaces.
// DATA_DIR lets a container point this at a mounted volume; unset, the
// database lives next to index.js exactly as before.
const db = openDatabase(path.join(process.env.DATA_DIR || __dirname, 'data.sqlite'));
client.db = db;
client.memory = new PersistentMap(db, 'memory');
client.messageCounts = new PersistentMap(db, 'messageCounts');
client.autoResponseRates = new PersistentMap(db, 'autoResponseRates');
// Opt-in allowlist of channels where ambient auto-responses are active.
// channelId -> guildId. Empty = the bot auto-responds nowhere until an admin
// runs /channels add. (Direct @mentions are never gated by this.)
client.allowedChannels = new PersistentMap(db, 'allowedChannels');

// The stats_events usage log is append-only; prune old rows at startup and
// once a day so the database doesn't grow unbounded. unref() (where the
// runtime supports it) keeps this timer from holding the process open.
pruneStatsEvents(db);
const statsPruneInterval = setInterval(() => pruneStatsEvents(db), 24 * 60 * 60 * 1000);
statsPruneInterval.unref?.();

// The LLM client. Provider is config-driven (OpenRouter by default) — see
// utils/config.js for the presets and utils/llm.js for the request wrapper.
const llm = createLlmClient(config);
client.llm = llm;
client.config = config;

safeLog(`[BOOT] LLM provider: ${describeProvider(config)} — model ${config.MODEL_NAME}`);


for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		// Set a new item in the Collection with the key as the command name and the value as the exported module
		if ('data' in command && 'execute' in command) {
			client.commands.set(command.data.name, command);
		} else {
			safeLog(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith('.js'));

for (const file of eventFiles) {
	const filePath = path.join(eventsPath, file);
	const event = require(filePath);
	const hasName = Boolean(event.name);
	const hasExecute = typeof event.execute === 'function';
	if (!hasName && !hasExecute) {
		// Shared helper module that happens to live in events/ (e.g. autoResponseState),
		// not an event handler. Skip silently.
		continue;
	}
	if (!hasName || !hasExecute) {
		safeLog(`[WARNING] The event at ${filePath} is missing a required "name" or "execute" property.`);
		continue;
	}
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	} else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

client.cooldowns = new Collection();
// Per-channel throttle for reaction GIFs. Deliberately in-memory and not a
// PersistentMap: a restart forgetting that a GIF was posted ten minutes ago is
// harmless, and this is written far more often than it is read.
client.mediaCooldowns = new Map();

// --- Crash guards & graceful shutdown ---------------------------------------

let isShuttingDown = false;

// Cleanly tear down the gateway connection and flush/close SQLite, then exit.
// Idempotent so overlapping signals (or a signal during an uncaught exception)
// only run the cleanup once. Every step is isolated so one failure can't block
// the rest.
async function shutdown(signal, code = 0) {
	if (isShuttingDown) return;
	isShuttingDown = true;
	safeLog(`\n[SHUTDOWN] Received ${signal}, cleaning up...`);

	try {
		await client.destroy();
	} catch (error) {
		safeError('[SHUTDOWN] Error destroying Discord client:', error);
	}

	try {
		// Fold the WAL back into the main db file so the on-disk state is tidy.
		db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
		db.close();
	} catch (error) {
		safeError('[SHUTDOWN] Error closing database:', error);
	}

	process.exit(code);
}

// Keep the bot alive on a stray rejection; just surface it (scrubbed).
process.on('unhandledRejection', (reason) => {
	safeError('[FATAL] Unhandled promise rejection:', reason);
});

// After an uncaught exception the process state is unreliable, so log, clean
// up, and exit non-zero for a supervisor to restart.
process.on('uncaughtException', (error) => {
	safeError('[FATAL] Uncaught exception:', error);
	shutdown('uncaughtException', 1);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Log in to Discord with your client's token
client.login(token).catch(async (error) => {
	safeError('[FATAL] Failed to log in to Discord:', error);
	await shutdown('LOGIN_FAIL', 1);
});
