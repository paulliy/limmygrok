const { SlashCommandBuilder } = require('discord.js');
const { resolveConfig } = require('../../utils/config');
const { safeError } = require('../../utils/log');
const { requestChatCompletion, describeLlmError } = require('../../utils/llm');
const { buildReplyContext } = require('../../utils/prompt');
const { applyServerVoice, samplingParamsFor } = require('../../utils/voice');
const { createStreamAnimator, stripThinkAndCitations, truncateForDiscord } = require('../../utils/streamingReply');

const fallbackConfig = resolveConfig() || {};

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
        const client = interaction.client;
        const llm = client.llm || client.openWebUI;
        const modelName = client.config?.MODEL_NAME || fallbackConfig.MODEL_NAME;
        let animator;

        try {
            // Same learned dialect the chat paths use, so /generatestring
            // sounds like the server too.
            const { systemPrompt, profile } = buildReplyContext({
                db: client.db,
                guildId: interaction.guildId,
                queryText: userInput,
            });

            const completion = await requestChatCompletion(llm, {
                model: modelName,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userInput }
                ],
                stream: true,
                ...samplingParamsFor(profile),
            }, {
                requestOptions: { timeout: 120_000 },
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

            const finalContent = applyServerVoice(
                stripThinkAndCitations(animator.content),
                profile,
                { botName: client.user?.username }
            );
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
            safeError('[GENE] LLM error:', error);
            await interaction.editReply(describeLlmError(error, client.config || fallbackConfig)).catch(() => {});
        } finally {
            if (animator) {
                animator.finish();
            }
        }
    },
};