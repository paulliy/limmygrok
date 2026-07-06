const { MODEL_NAME } = require('../config.json');
const { parseimgs, resolveImageUrlsToBase64, safeLog, safeError, createChatCompletionWithFallback, SYSTEM_PROMPT } = require('../utils/parseimgs');
const { recordEvent } = require('../utils/stats');
const { createStreamAnimator, stripThinkAndCitations, truncateForDiscord, INITIAL_LOADING_TEXT } = require('../utils/streamingReply');



async function generateAutoresponce(message) {
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const history = message.client.memory.get(channelId) || [];

    // Use the last 20 messages for context
    const contextMessages = history.slice(-20);

    if (contextMessages.length === 0) return;

    await message.channel.sendTyping();

    const openWebUI = message.client.openWebUI;
    let replyMessage;
    try {
        replyMessage = await message.reply(INITIAL_LOADING_TEXT);
    } catch (error) {
        safeError('Failed to send initial auto-response reply:', error);
        return;
    }

    safeLog(`\n[DEBUG] --- AUTO-RESPONSE STREAM STARTED ---`);

    // 1. Start the animation interval IMMEDIATELY
    const animator = createStreamAnimator({
        edit: (chunk) => replyMessage.edit(chunk),
    });

    try {
        const processedMessages = parseimgs(contextMessages);

        if (processedMessages.length === 0) {
            animator.finish();
            await replyMessage.delete().catch(() => {}); // Clean up the "Thinking" message
            return;
        }

        const logPayload = {
            model: MODEL_NAME,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...processedMessages],
            stream: true,
        };
        safeLog(`\n[DEBUG] API Payload (pre-resolution):`, JSON.stringify(logPayload, null, 2));

        const apiPayload = {
            model: MODEL_NAME,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...(await resolveImageUrlsToBase64(processedMessages))],
            stream: true,
        };

        const completion = await createChatCompletionWithFallback(openWebUI, apiPayload);

        if (completion.isStream) {
            for await (const chunk of completion.stream) {
                const deltaContent = chunk.choices?.[0]?.delta?.content;
                if (deltaContent) {
                    animator.append(deltaContent);
                    process.stdout.write(deltaContent);
                }
            }
        } else {
            animator.append(completion.response?.choices?.[0]?.message?.content || '');
        }

        animator.finish();
        safeLog(`\n[DEBUG] --- AUTO-RESPONSE STREAM FINISHED ---`);

        const finalContent = stripThinkAndCitations(animator.content);

        const truncatedFinalContent = truncateForDiscord(finalContent);

        if (!finalContent) {
            await replyMessage.edit('The model only returned thinking content with no final response.');
            return;
        }

        await replyMessage.edit(truncatedFinalContent);

        recordEvent(message.client, 'autoresponse', {
            guildId: message.guildId,
            channelId: message.channel.id,
        });

        // Add the bot's final response to the memory
        let currentMemory = message.client.memory.get(message.channel.id) || [];
        currentMemory.push({ role: 'assistant', content: finalContent });
        if (currentMemory.length > 20) {
            currentMemory = currentMemory.slice(-20);
        }
        message.client.memory.set(message.channel.id, currentMemory);

        safeLog(`\n[DEBUG] Updated Memory:`, JSON.stringify(currentMemory, null, 2));

    } catch (error) {
        animator.finish();
        safeError('OpenWebUI Error:', error);
        await replyMessage.edit(`Error: ${error.message ?? 'Something went wrong.'}`).catch(() => {});
    } finally {
        animator.finish();
    }
}

module.exports = { generateAutoresponce };