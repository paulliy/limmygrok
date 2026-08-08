const { Events, Collection } = require('discord.js');
const { resolveConfig } = require('../utils/config');
const { parseimgs, resolveImageUrlsToBase64 } = require('../utils/parseimgs');
const { safeLog, safeError, debugLog } = require('../utils/log');
const { requestChatCompletion, describeLlmError, pickModel } = require('../utils/llm');
const { buildReplyContext } = require('../utils/prompt');
const { applyServerVoice, samplingParamsFor } = require('../utils/voice');
const { recordMessage } = require('../utils/corpus');
const { pickGarnishGif } = require('../utils/media');
const { isDirectlyAddressed, addressReason, aliasesFor } = require('../utils/triggers');
const { recordEvent } = require('../utils/stats');
const { createStreamAnimator, stripThinkAndCitations, withGarnish, INITIAL_LOADING_TEXT } = require('../utils/streamingReply');

const fallbackConfig = resolveConfig() || {};

// Direct-address handler: @mentions, replies to the bot, and plain use of its
// name. Fires in any channel regardless of the auto-response allowlist —
// someone talking straight to the bot always gets an answer. Ambient chatter
// is events/messageStore.js's job.

// Removes the ways the bot was addressed from the text, so the model sees the
// actual question rather than its own name. Mention IDs, the bot's role
// mention, and a leading "limmygrok," style vocative all go.
function stripAddressing(message) {
    let content = message.content || '';
    const botId = message.client.user.id;

    content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '');

    message.mentions?.roles?.forEach((role) => {
        if (role.name === message.client.user.username) {
            content = content.replace(new RegExp(`<@&${role.id}>`, 'g'), '');
        }
    });

    for (const name of aliasesFor(message.client)) {
        if (!name || name.length < 3) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Only strip the name when it opens the message ("limmygrok what is
        // x"). Mid-sentence uses are part of what was said.
        content = content.replace(new RegExp(`^\\s*${escaped}\\s*[,:]?\\s*`, 'i'), '');
    }

    return content.trim();
}

module.exports = {
    name: Events.MessageCreate,
    once: false,
    async execute(message) {
        if (message.author.bot) return;
        if (!isDirectlyAddressed(message)) return;

        const { cooldowns } = message.client;
        const commandName = 'mention';
        const defaultCooldownDuration = 5;

        if (!cooldowns.has(commandName)) {
            cooldowns.set(commandName, new Collection());
        }

        const now = Date.now();
        const timestamps = cooldowns.get(commandName);
        const cooldownAmount = defaultCooldownDuration * 1000;

        if (timestamps.has(message.author.id)) {
            const expirationTime = timestamps.get(message.author.id) + cooldownAmount;
            if (now < expirationTime) return;
        }

        const client = message.client;
        const llm = client.llm || client.openWebUI;
        const llmConfig = client.config || fallbackConfig;

        await message.channel.sendTyping();
        const typingInterval = setInterval(() => message.channel.sendTyping(), 8_000);

        let animator;
        let replyMessage;

        try {
            timestamps.set(message.author.id, now);
            setTimeout(() => timestamps.delete(message.author.id), cooldownAmount);

            const messageContent = stripAddressing(message);

            // Reuse the same attachment/raw-URL image detection as the rest of
            // the bot, but on the addressing-stripped text. author/member are
            // passed through so these turns get the same "Name: text" speaker
            // prefix as ambient turns.
            const parsedArray = parseimgs({
                role: 'user',
                content: messageContent,
                attachments: message.attachments,
                author: message.author,
                member: message.member,
            });

            if (parsedArray.length === 0) {
                await message.reply('Ask me smth chud...');
                return;
            }

            const userMessage = parsedArray[0];

            // Messages addressed to the bot are part of how this server talks,
            // so they feed the dialect too — regardless of the allowlist, since
            // the user opted in by talking to it.
            if (message.guildId && messageContent) {
                recordMessage(client.db, {
                    guildId: message.guildId,
                    channelId: message.channel.id,
                    userId: message.author.id,
                    author: message.member?.displayName || message.author.displayName || message.author.username,
                    content: messageContent,
                });
            }

            let history = client.memory.get(message.channel.id) || [];
            let replaced = false;
            if (history.length > 0) {
                const lastMsg = history[history.length - 1];
                if (lastMsg.role === 'user') {
                    let lastContentStr = '';
                    if (typeof lastMsg.content === 'string') {
                        lastContentStr = lastMsg.content;
                    } else if (Array.isArray(lastMsg.content)) {
                        const textPart = lastMsg.content.find(part => part && part.type === 'text');
                        if (textPart && typeof textPart.text === 'string') {
                            lastContentStr = textPart.text;
                        }
                    }
                    // Only dedup when the last stored entry is genuinely THIS
                    // same turn (exact raw content).
                    if (lastContentStr === message.content) {
                        history[history.length - 1] = userMessage;
                        replaced = true;
                    }
                }
            }
            if (!replaced) {
                history.push(userMessage);
            }

            client.memory.set(message.channel.id, history);

            replyMessage = await message.reply(INITIAL_LOADING_TEXT);

            // Start the animation before awaiting the API so the loading
            // phrases run while the request is in flight.
            animator = createStreamAnimator({
                edit: (chunk) => replyMessage.edit(chunk),
            });

            const currentHistory = client.memory.get(message.channel.id) || [];

            // Intentional: mentions send the model the last 5 turns even though
            // memory retains 20. A direct address is a focused, in-the-moment
            // ask, so a tight window keeps replies on-topic. (Ambient
            // auto-responses use the full 20; that difference is by design.)
            const baseMessages = parseimgs(currentHistory.slice(-5));

            // The learned server dialect + precedent retrieved for whatever was
            // just said. This is what makes the reply sound like the server.
            const { systemPrompt, profile } = buildReplyContext({
                db: client.db,
                guildId: message.guildId,
                queryText: messageContent,
            });

            debugLog('[MENTION] system prompt:', systemPrompt);

            const payloadMessages = [
                { role: 'system', content: systemPrompt },
                ...(await resolveImageUrlsToBase64(baseMessages)),
            ];

            const apiPayload = {
                // Text-only model for ordinary chat, vision model only when an
                // image is actually attached.
                model: pickModel(llmConfig, payloadMessages),
                messages: payloadMessages,
                stream: true,
                ...samplingParamsFor(profile),
            };

            const completion = await requestChatCompletion(llm, apiPayload, { config: llmConfig });

            // Tracked so the voice filter can drop a sentence the token budget
            // cut off mid-word rather than posting the fragment.
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
                if (replyMessage) {
                    await replyMessage.edit('The model only returned thinking content with no final response.');
                }
                return;
            }

            // Occasionally garnish with a GIF this server actually posts in
            // situations like this. Rare by design (see utils/media.js) — the
            // whole point is that it lands as a reaction, not a tic.
            const garnish = pickGarnishGif(client.db, message.guildId, messageContent, {
                channelId: message.channel.id,
                cooldowns: client.mediaCooldowns,
            });

            if (replyMessage) {
                await replyMessage.edit(withGarnish(finalContent, garnish));
            }

            recordEvent(client, 'mention', {
                name: addressReason(message),
                guildId: message.guildId,
                channelId: message.channel.id,
                userId: message.author.id,
            });

            // Add the bot's final response to the memory
            let currentMemory = client.memory.get(message.channel.id) || [];
            currentMemory.push({ role: 'assistant', content: finalContent });
            if (currentMemory.length > 20) {
                currentMemory = currentMemory.slice(-20);
            }
            client.memory.set(message.channel.id, currentMemory);

        } catch (error) {
            if (animator) animator.finish();
            safeError('[MENTION] LLM error:', error);
            if (replyMessage) {
                await replyMessage.edit(describeLlmError(error, llmConfig)).catch(() => {});
            }
        } finally {
            if (animator) animator.finish();
            clearInterval(typingInterval);
        }
    },
};
