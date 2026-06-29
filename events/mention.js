const { Events, Collection } = require('discord.js');

module.exports = {
	name: Events.MessageCreate,
	once: false,
	async execute(message) {

		if (message.author.bot) return;


		if (message.mentions.has(message.client.user)) {
			const { cooldowns } = message.client;
			const commandName = 'mention'; // Use a fixed name for the mention event
			const defaultCooldownDuration = 5; // 5 seconds

			if (!cooldowns.has(commandName)) {
				cooldowns.set(commandName, new Collection());
			}

			const now = Date.now();
			const timestamps = cooldowns.get(commandName);
			const cooldownAmount = defaultCooldownDuration * 1000;

			if (timestamps.has(message.author.id)) {
				const expirationTime = timestamps.get(message.author.id) + cooldownAmount;

				if (now < expirationTime) {
					const expiredTimestamp = Math.round(expirationTime / 1000);
					// Silently ignore to prevent spam, or you could reply with a cooldown message.
					return;
				}
			}
			const openWebUI = message.client.openWebUI;


			await message.channel.sendTyping();
			const typingInterval = setInterval(
				() => message.channel.sendTyping(),
				8_000,
			);


			const botMentionRegex = new RegExp(
				`<@!?${message.client.user.id}>`, 'g',
			);
			const messageContent = message.content.replace(botMentionRegex, '').trim();

			timestamps.set(message.author.id, now);
			setTimeout(() => timestamps.delete(message.author.id), cooldownAmount);

			if (!messageContent) {
				message.reply('You mentioned me, but did not provide any input!');
				return;
			}

			const userInput = messageContent;

			try { // eslint-disable-line no-useless-catch
				const response = await openWebUI.chat.completions.create({
						model: 'limmygene',
						messages: [{ role: 'user', content: userInput }],
						stream: false,
						features: {
							web_search: false,
							image_generation: false,
							code_interpreter: false,
						},
					},
					{ timeout: 120_000 }, 
				);

				let content = response.choices?.[0]?.message?.content;

				if (!content) {
					await message.reply('No response was generated.');
					return;
				}


				content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
				content = content.replace(/\[\d+\]/g, '').trim();

				if (!content) {
					await message.reply('The model only returned thinking content with no final response.');
					return;
				}


				await message.reply(content.length > 2000 ? content.slice(0, 1997) + '...' : content);
			} catch (error) {
				console.error('OpenWebUI Error:', error);
				await message.reply(`Error: ${error.message ?? 'Something went wrong.'}`);
			} finally {
				clearInterval(typingInterval);
			}
		}
	},
};