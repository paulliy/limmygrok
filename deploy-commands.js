const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { safeLog, safeError } = require('./utils/log');
const { assertRequiredConfig, resolveConfig } = require('./utils/config');

const config = resolveConfig();
if (!config) {
	safeError('[FATAL] No configuration found. Set DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID in the environment, or provide a config.json.');
	process.exit(1);
}
try {
	assertRequiredConfig(config, ['clientId', 'guildId', 'token']);
} catch (error) {
	safeError(`[FATAL] ${error.message}`);
	process.exit(1);
}
const { clientId, guildId, token } = config;

const commands = [];
// Grab all the command folders from the commands directory you created earlier
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	// Grab all the command files from the commands directory you created earlier
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
	// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		if ('data' in command && 'execute' in command) {
			commands.push(command.data.toJSON());
		} else {
			safeLog(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(token);

// and deploy your commands!
(async () => {
	try {
		safeLog(`Started refreshing ${commands.length} application (/) commands.`);

		// The put method is used to fully refresh all commands in the guild with the current set
		const data = await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });

		safeLog(`Successfully reloaded ${data.length} application (/) commands.`);
	} catch (error) {
		// And of course, make sure you catch and log any errors!
		safeError(error);
	}
})();