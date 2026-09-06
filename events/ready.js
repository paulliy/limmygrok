const {Events} = require('discord.js');
const { safeLog } = require('../utils/log');

module.exports = {
	name: Events.ClientReady,
	once: true,
	execute(client) {
		safeLog(`Ready! Logged in as ${client.user.tag}`);
	},
};