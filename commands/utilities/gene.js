const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generatestring')
        .setDescription('Generates a string based on your input! (Legacy command, use @limmyGene instead)')
        .addStringOption((option) =>
            option.setName('input').setDescription('The input to use').setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const userInput = interaction.options.getString('input');
        const openWebUI = interaction.client.openWebUI;

        try {
            const stream = await openWebUI.chat.completions.create({
                model: 'limmygene',
                messages: [
                    { role: 'user', content: userInput }
                ],
                stream: true,
                // Removed non-standard 'features' object to prevent OpenWebUI from dropping the request
            }, {
                timeout: 120_000,
            });

            let content = '';
            let lastDisplayedContent = '';
            let isEditing = false;
            let isFinished = false;

            // Decoupled editing interval prevents Discord rate limits from blocking the stream
            const editInterval = setInterval(async () => {
                if (isFinished || isEditing) return;
                
                const displayContent = content
                    .replace(/<think>(?:[\s\S]*?<\/think>|[\s\S]*$)/gi, '')
                    .replace(/\[\d+\]/g, '')
                    .trim();

                const safeContent = displayContent || '*Thinking...*';
                const chunkToSend = safeContent.slice(0, 2000);

                if (chunkToSend !== lastDisplayedContent) {
                    isEditing = true;
                    try {
                        await interaction.editReply(chunkToSend);
                        lastDisplayedContent = chunkToSend;
                    } catch (error) {
                        console.error('Edit error:', error);
                    } finally {
                        isEditing = false;
                    }
                }
            }, 1500);

            // Read the stream as fast as it arrives without awaiting Discord
            for await (const chunk of stream) {
                const deltaContent = chunk.choices?.[0]?.delta?.content;
                if (deltaContent) {
                    content += deltaContent;
                }
            }

            isFinished = true;
            clearInterval(editInterval);

            const finalContent = content
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .replace(/\[\d+\]/g, '')
                .trim();

            if (!finalContent) {
                await interaction.editReply('The model only returned thinking content with no final response.');
                return;
            }

            if (finalContent.length > 2000) {
                await interaction.editReply(finalContent.slice(0, 1997) + '...');
            } else {
                await interaction.editReply(finalContent);
            }

        } catch (error) {
            console.error('OpenWebUI Error:', error);
            await interaction.editReply(`Error: ${error.message ?? 'Something went wrong.'}`).catch(() => {});
        }
    },
};