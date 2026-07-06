const {Events} = require('discord.js');
const { safeLog } = require('../utils/parseimgs');

module.exports = {
	name: Events.ClientReady,
	once: true,
	execute(client) {
		safeLog(`Ready! Logged in as ${client.user.tag}`);
	},
};