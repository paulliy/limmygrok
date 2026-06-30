// Require the necessary discord.js classes
const { Client, Events, GatewayIntentBits, Collection, MessageFlags} = require('discord.js');
const { token, APIkey, API_BASE_URL } = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');
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
const {OpenAI} = require('openai');
// When the client is ready, run this code (only once).
// The distinction between `client: Client<boolean>` and `readyClient: Client<true>` is important for TypeScript developers.
// The distinction between `client: Client` and `readyClient: Client<true>` is important for TypeScript developers.
// It makes some properties non-nullable.
client.commands = new Collection(); 

const openWebUI = new OpenAI({
  apiKey: APIkey,
  baseURL: API_BASE_URL
});
client.openWebUI = openWebUI;


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
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith('.js'));

for (const file of eventFiles) {
	const filePath = path.join(eventsPath, file);
	const event = require(filePath);
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	} else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

client.cooldowns = new Collection();

// Log in to Discord with your client's token
client.login(token);
