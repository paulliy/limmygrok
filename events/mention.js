const { Events, Collection } = require('discord.js');
const {MODEL_NAME} = require('../config.json');
const { parseimgs, resolveImageUrlsToBase64, safeLog, safeError } = require('../utils/parseimgs');

module.exports = {
    name: Events.MessageCreate,
    once: false,
    async execute(message) {
        if (message.author.bot) return;

        if (message.mentions.has(message.client.user)) {
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

            let editInterval;
            let replyMessage;
            let isFinished = false;

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
                // touches URLs, so image detection is unaffected).
                const parsedArray = parseimgs({
                    role: 'user',
                    content: messageContent,
                    attachments: message.attachments,
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
                        if (lastContentStr === message.content || lastContentStr.includes(message.client.user.id)) {
                            history[history.length - 1] = userMessage;
                            replaced = true;
                        }
                    }
                }
                if (!replaced) {
                    history.push(userMessage);
                }

                message.client.memory.set(message.channel.id, history);

                replyMessage = await message.reply('*Thinking.*');

                let content = '';
                let lastDisplayedContent = '*Thinking.*';
                let isEditing = false;

                const loadingPhrases = [
                    'Thinking', 'Pondering', 'Questing', 'Holding site',
                    'Playing Valorant', 'Winning', 'Cooking', 'Strategizing',
                    'Turtletiming', 'Coding', 'Synthizing', 'Baldliking',
                    'Chudding', 'Meowling', 'Climbing rocks', 'Whiffing hard',
                    'Bawberrying', 'Bankheading', 'Geneing', 'Limmying', 'Praying',
                    'Five Stacking A', 'Dying mid', 'Eating Goldfish',
                    'Saving the World', 'Plain Janing','Ai-ing','Listening to AJR',
                    'Getting a new permit','Watching the sunset','Reading','Writing',
                    'Exploring','Juggling','Solving','Aiming','Cleaning',
                    'Painting','Dancing','Singing','Tinkering','Locking in',
                    'Stargazing','Learning','Building','Sleeping','Flicking',
                    'Waiting for tim','Scrolling','Watching cote','Holding mid',
                    'Whiffing again','Full buying','Picking up the bomb','Defusing','Planting','Rotating',
                    'Joining VC','Wordle streaking','Playing Smash','Creating Limmygrok','Deadlotting',
                    'Queuing','Gooning','Mutting','Baiting','Boosting'
                ];
                let phraseIndex = Math.floor(Math.random() * loadingPhrases.length);
                let frameIndex = 0;
                const dotFrames = ['.', ':', ': .', ': :', ': : .',': : : .',': : : :'];
                safeLog(`\n[DEBUG] --- STREAM STARTED ---`);

                // 1. Start the animation interval IMMEDIATELY, before waiting on the API
                editInterval = setInterval(async () => {
                    if (isFinished) return;
                    const displayContent = content
                        .replace(/<think>(?:[\s\S]*?<\/think>|[\s\S]*$)/gi, '')
                        .replace(/\[\d+\]/g, '')
                        .trim();

                    let safeContent;

                    if (displayContent) {
                        safeContent = displayContent;
                    } else {
                        safeContent = `*${loadingPhrases[phraseIndex]} ${dotFrames[frameIndex]}*`;

                        frameIndex++;

                        if (frameIndex >= dotFrames.length) {
                            frameIndex = 0;
                            phraseIndex = Math.floor(Math.random() * loadingPhrases.length);
                        }
                    }

                    const chunkToSend = safeContent.slice(0, 2000);
                    if (isEditing || chunkToSend === lastDisplayedContent) return;

                    isEditing = true;
                    try {
                        if (replyMessage) {
                            await replyMessage.edit(chunkToSend);
                            lastDisplayedContent = chunkToSend;
                        }
                    } catch (error) {
                        safeError('\n[DEBUG Edit Error]:', error.message);
                    } finally {
                        isEditing = false;
                    }
                }, 1500);

                const currentHistory = message.client.memory.get(message.channel.id) || [];
                safeLog(`\n[DEBUG] Retrieved History:`, JSON.stringify(currentHistory, null, 2));
                const apiPayload = {
                    model: MODEL_NAME,
                    messages: await resolveImageUrlsToBase64(parseimgs(currentHistory.slice(-5))),
                    stream: true,
                };
                safeLog(`\n[DEBUG] API Payload:`, JSON.stringify(apiPayload, null, 2));

                // 2. Now await the API (the animation is already running in the background)
                const stream = await openWebUI.chat.completions.create(apiPayload);

                for await (const chunk of stream) {
                    const deltaContent = chunk.choices?.[0]?.delta?.content;
                    if (deltaContent) {
                        content += deltaContent;
                        process.stdout.write(deltaContent);
                    }
                }

                isFinished = true;
                safeLog(`\n[DEBUG] --- STREAM FINISHED ---`);

                const finalContent = content
                    .replace(/<think>[\s\S]*?<\/think>/gi, '')
                    .replace(/\[\d+\]/g, '')
                    .trim();

                const truncatedFinalContent = finalContent.length > 2000
                    ? finalContent.slice(0, 1997) + '/...'
                    : finalContent;

                if (!finalContent) {
                    if (replyMessage) {
                        await replyMessage.edit('The model only returned thinking content with no final response.');
                    }
                    return;
                }

                if (replyMessage) {
                    await replyMessage.edit(truncatedFinalContent);
                }

                // Add the bot's final response to the memory
                let currentMemory = message.client.memory.get(message.channel.id) || [];
                currentMemory.push({ role: 'assistant', content: finalContent });
                if (currentMemory.length > 5) {
                    currentMemory = currentMemory.slice(-5);
                }
                message.client.memory.set(message.channel.id, currentMemory);
                safeLog(`\n[DEBUG] Updated Memory:`, JSON.stringify(currentMemory, null, 2));

            } catch (error) {
                safeError('OpenWebUI Error:', error);
                if (replyMessage) {
                    await replyMessage.edit(`Error: ${error.message ?? 'Something went wrong.'}`).catch(() => {});
                }
            } finally {
                isFinished = true;
                if (editInterval) {
                    clearInterval(editInterval);
                }
                clearInterval(typingInterval);
            }
        }
    },
};