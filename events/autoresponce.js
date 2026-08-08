const { resolveConfig } = require('../utils/config');
const { parseimgs, resolveImageUrlsToBase64 } = require('../utils/parseimgs');
const { safeError, debugLog } = require('../utils/log');
const { requestChatCompletion, describeLlmError, pickModel } = require('../utils/llm');
const { buildReplyContext, conversationText } = require('../utils/prompt');
const { applyServerVoice, samplingParamsFor } = require('../utils/voice');
const { pickGarnishGif } = require('../utils/media');
const { recordEvent } = require('../utils/stats');
const { createStreamAnimator, stripThinkAndCitations, withGarnish, INITIAL_LOADING_TEXT } = require('../utils/streamingReply');

const fallbackConfig = resolveConfig() || {};

async function generateAutoresponce(message) {
    if (message.author.bot) return;

    const client = message.client;
    const channelId = message.channel.id;
    const history = client.memory.get(channelId) || [];

    // Use the last 20 messages for context
    const contextMessages = history.slice(-20);

    if (contextMessages.length === 0) return;

    await message.channel.sendTyping();

    const llm = client.llm || client.openWebUI;
    const llmConfig = client.config || fallbackConfig;

    let replyMessage;
    try {
        replyMessage = await message.reply(INITIAL_LOADING_TEXT);
    } catch (error) {
        safeError('Failed to send initial auto-response reply:', error);
        return;
    }

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

        const { systemPrompt, profile } = buildReplyContext({
            db: client.db,
            guildId: message.guildId,
            queryText: conversationText(processedMessages),
        });

        debugLog('[AUTORESPONSE] system prompt:', systemPrompt);

        const payloadMessages = [
            { role: 'system', content: systemPrompt },
            ...(await resolveImageUrlsToBase64(processedMessages)),
        ];

        const apiPayload = {
            // Text-only model for ordinary chat, vision model only when an
            // image is actually in the context.
            model: pickModel(llmConfig, payloadMessages),
            messages: payloadMessages,
            stream: true,
            ...samplingParamsFor(profile),
        };

        const completion = await requestChatCompletion(llm, apiPayload, { config: llmConfig });

        let finishReason = null;

        if (completion.isStream) {
            for await (const chunk of completion.stream) {
                const deltaContent = chunk.choices?.[0]?.delta?.content;
                if (deltaContent) animator.append(deltaContent);
                finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
            }
        } else {
            animator.append(completion.response?.choices?.[0]?.message?.content || '');
            finishReason = completion.response?.choices?.[0]?.finish_reason ?? null;
        }

        animator.finish();

        // Prompting asked for the server's voice; this enforces it.
        const finalContent = applyServerVoice(
            stripThinkAndCitations(animator.content),
            profile,
            { botName: client.user?.username, wasTruncated: finishReason === 'length' }
        );

        if (!finalContent) {
            await replyMessage.edit('The model only returned thinking content with no final response.');
            return;
        }

        // Occasionally garnish with a GIF this server actually posts in
        // situations like this. Rare by design (see utils/media.js).
        const garnish = pickGarnishGif(client.db, message.guildId, conversationText(processedMessages), {
            channelId: message.channel.id,
            cooldowns: client.mediaCooldowns,
        });

        await replyMessage.edit(withGarnish(finalContent, garnish));

        recordEvent(client, 'autoresponse', {
            guildId: message.guildId,
            channelId: message.channel.id,
        });

        // Add the bot's final response to the memory
        let currentMemory = client.memory.get(message.channel.id) || [];
        currentMemory.push({ role: 'assistant', content: finalContent });
        if (currentMemory.length > 20) {
            currentMemory = currentMemory.slice(-20);
        }
        client.memory.set(message.channel.id, currentMemory);

    } catch (error) {
        animator.finish();
        safeError('[AUTORESPONSE] LLM error:', error);
        await replyMessage.edit(describeLlmError(error, llmConfig)).catch(() => {});
    } finally {
        animator.finish();
    }
}

module.exports = { generateAutoresponce };
