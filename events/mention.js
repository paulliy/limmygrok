const { Events, Collection } = require('discord.js');
const { MODEL_NAME } = require('../config.json');
const { parseimgs, resolveImageUrlsToBase64, safeLog, safeError, createChatCompletionWithFallback, SYSTEM_PROMPT } = require('../utils/parseimgs');
const { recordEvent } = require('../utils/stats');
const { createStreamAnimator, stripThinkAndCitations, truncateForDiscord, INITIAL_LOADING_TEXT } = require('../utils/streamingReply');

module.exports = {
    name: Events.MessageCreate,
    once: false,
    async execute(message) {
        if (message.author.bot) return;

        const isMentioned = message.mentions.users
            ? message.mentions.users.has(message.client.user.id)
            : message.mentions.has(message.client.user, { ignoreEveryone: true, ignoreRoles: true });

        if (isMentioned) {
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

            const openWebUI = message.client.openWebUI;

            await message.channel.sendTyping();
            const typingInterval = setInterval(() => message.channel.sendTyping(), 8_000);

            let animator;
            let replyMessage;

            try {
                timestamps.set(message.author.id, now);
                setTimeout(() => timestamps.delete(message.author.id), cooldownAmount);

                let messageContent = message.content;
                const userMentionRegex = new RegExp(`<@!?${message.client.user.id}>`, 'g');
                messageContent = messageContent.replace(userMentionRegex, '');

                message.mentions.roles.forEach(role => {
                    if (role.name === message.client.user.username) {
                        messageContent = messageContent.replace(new RegExp(`<@&${role.id}>`, 'g'), '');
                    }
                });

                messageContent = messageContent.trim();

                // Reuse the same attachment/raw-URL image detection as the rest of the
                // bot, but on the mention-stripped text (mention stripping never
                // touches URLs, so image detection is unaffected). author/member are
                // passed through so mention turns get the same "Name: text" speaker
                // prefix as ambient turns (messageStore.js parses the raw message).
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

                let history = message.client.memory.get(message.channel.id) || [];
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
                        // same turn (exact raw content). Matching on a bare bot-id
                        // substring would wrongly overwrite an unrelated prior
                        // message that merely happens to contain the id.
                        if (lastContentStr === message.content) {
                            history[history.length - 1] = userMessage;
                            replaced = true;
                        }
                    }
                }
                if (!replaced) {
                    history.push(userMessage);
                }

                message.client.memory.set(message.channel.id, history);

                replyMessage = await message.reply(INITIAL_LOADING_TEXT);

                safeLog(`\n[DEBUG] --- STREAM STARTED ---`);

                // 1. Start the animation interval IMMEDIATELY, before waiting on the API
                animator = createStreamAnimator({
                    edit: (chunk) => replyMessage.edit(chunk),
                });

                const currentHistory = message.client.memory.get(message.channel.id) || [];
                safeLog(`\n[DEBUG] Retrieved History:`, JSON.stringify(currentHistory, null, 2));

                // Intentional: mentions only send the model the last 5 turns even
                // though memory retains 20. A direct @mention is a focused, in-the-
                // moment ask, so the most recent context matters most — a tight window
                // keeps replies on-topic and avoids dragging in stale conversation.
                // (Ambient auto-responses use the full 20; that difference is by design.)
                const baseMessages = parseimgs(currentHistory.slice(-5));
                const logPayload = {
                    model: MODEL_NAME,
                    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...baseMessages],
                    stream: true,
                };
                safeLog(`\n[DEBUG] API Payload (pre-resolution):`, JSON.stringify(logPayload, null, 2));

                const apiPayload = {
                    model: MODEL_NAME,
                    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...(await resolveImageUrlsToBase64(baseMessages))],
                    stream: true,
                };

                // 2. Now await the API (the animation is already running in the background)
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
                safeLog(`\n[DEBUG] --- STREAM FINISHED ---`);

                const finalContent = stripThinkAndCitations(animator.content);

                const truncatedFinalContent = truncateForDiscord(finalContent);

                if (!finalContent) {
                    if (replyMessage) {
                        await replyMessage.edit('The model only returned thinking content with no final response.');
                    }
                    return;
                }

                if (replyMessage) {
                    await replyMessage.edit(truncatedFinalContent);
                }

                recordEvent(message.client, 'mention', {
                    guildId: message.guildId,
                    channelId: message.channel.id,
                    userId: message.author.id,
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
                if (animator) {
                    animator.finish();
                }
                safeError('OpenWebUI Error:', error);
                if (replyMessage) {
                    await replyMessage.edit(`Error: ${error.message ?? 'Something went wrong.'}`).catch(() => {});
                }
            } finally {
                if (animator) {
                    animator.finish();
                }
                clearInterval(typingInterval);
            }
        }
    },
};