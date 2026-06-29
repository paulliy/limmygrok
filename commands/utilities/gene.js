const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generatestring')
        .setDescription('Generates a string based on your input!')
        .addStringOption((option) =>
            option.setName('input').setDescription('The input to use').setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const userInput = interaction.options.getString('input');
        const openWebUI = interaction.client.openWebUI;

        try {
            const response = await openWebUI.chat.completions.create({
                model: 'limmygene',
                messages: [{ role: 'user', content: userInput }],
                stream: false,
                features: {
                    web_search: false,
                    image_generation: false,
                    code_interpreter: false,
                },
            }, {
                timeout: 120_000, 
            });

            let content = response.choices?.[0]?.message?.content;

            if (!content) {
                await interaction.editReply(' No response was generated.');
                return;
            }


            content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();


            content = content.replace(/\[\d+\]/g, '').trim();

            if (!content) {
                await interaction.editReply('The model only returned thinking content with no final response.');
                return;
            }

            // Discord has a 2000 character limit per message
            if (content.length > 2000) {
                await interaction.editReply(content.slice(0, 1997) + '...');
            } else {
                await interaction.editReply(content);
            }

        } catch (error) {
            console.error('OpenWebUI Error:', error);

            try {
                await interaction.editReply(`Error: ${error.message ?? 'Something went wrong.'}`);
            } catch (replyError) {
                console.error('Failed to send error reply (interaction may have expired):', replyError);
            }
        }
    },
};