const { SlashCommandBuilder } = require('discord.js');
const {MODEL_NAME} = require('../../config.json');
const { safeError, createChatCompletionWithFallback } = require('../../utils/parseimgs');
const { createStreamAnimator, stripThinkAndCitations, truncateForDiscord } = require('../../utils/streamingReply');

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
        let animator;

        try {
            const completion = await createChatCompletionWithFallback(openWebUI, {
                model: MODEL_NAME,
                messages: [
                    { role: 'user', content: userInput }
                ],
                stream: true,
                // Removed non-standard 'features' object to prevent OpenWebUI from dropping the request
            }, {
                timeout: 120_000,
            });

            // Decoupled editing interval prevents Discord rate limits from blocking the stream
            animator = createStreamAnimator({
                edit: (chunk) => interaction.editReply(chunk),
                usePhrases: false,
            });

            if (completion.isStream) {
                // Read the stream as fast as it arrives without awaiting Discord
                for await (const chunk of completion.stream) {
                    const deltaContent = chunk.choices?.[0]?.delta?.content;
                    if (deltaContent) {
                        animator.append(deltaContent);
                    }
                }
            } else {
                animator.append(completion.response?.choices?.[0]?.message?.content || '');
            }

            const finalContent = stripThinkAndCitations(animator.content);
            animator.finish();

            if (!finalContent) {
                await interaction.editReply('The model only returned thinking content with no final response.');
                return;
            }

            await interaction.editReply(truncateForDiscord(finalContent));

        } catch (error) {
            if (animator) {
                animator.finish();
            }
            safeError('OpenWebUI Error:', error);
            await interaction.editReply(`Error: ${error.message ?? 'Something went wrong.'}`).catch(() => {});
        } finally {
            if (animator) {
                animator.finish();
            }
        }
    },
};