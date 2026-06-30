const { Events, Collection } = require('discord.js');

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

            if (!messageContent) {
                message.reply('Ask me smth chud...');
                clearInterval(typingInterval); 
                return;
            }

            let replyMessage = await message.reply('*Thinking.*'); 

            let content = '';
            let lastDisplayedContent = '*Thinking.*'; 
            let isEditing = false;
            let isFinished = false;

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
                'Joining VC','Wordle streaking','Playing Smash','Creating Limmygrok'
            ];
            let phraseIndex = Math.floor(Math.random() * loadingPhrases.length);
            let frameIndex = 0;
            const dotFrames = ['.', ':', ': .', ': :', ': : .',': : : .',': : : :',': : : : .',': : : : :'];
            console.log(`\n[DEBUG] --- STREAM STARTED ---`);

            // 1. Start the animation interval IMMEDIATELY, before waiting on the API
            const editInterval = setInterval(async () => {
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
                    await replyMessage.edit(chunkToSend);
                    lastDisplayedContent = chunkToSend;
                } catch (error) {
                    console.error('\n[DEBUG Edit Error]:', error.message);
                } finally {
                    isEditing = false;
                }
            }, 1500);

            try { 
                const apiPayload = {
                    model: 'limmygene',
                    messages: [
                        { role: 'user', content: messageContent }
                    ],
                    stream: true,
                };

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
                console.log(`\n[DEBUG] --- STREAM FINISHED ---`);

                const finalContent = content
                    .replace(/<think>[\s\S]*?<\/think>/gi, '')
                    .replace(/\[\d+\]/g, '')
                    .trim();
                
                const truncatedFinalContent = finalContent.length > 2000 
                    ? finalContent.slice(0, 1997) + '...' 
                    : finalContent;

                if (!finalContent) {
                    await replyMessage.edit('The model only returned thinking content with no final response.');
                    return;
                }

                await replyMessage.edit(truncatedFinalContent);

            } catch (error) {
                console.error('OpenWebUI Error:', error);
                await replyMessage.edit(`Error: ${error.message ?? 'Something went wrong.'}`).catch(() => {});
            } finally {
                // Ensure intervals are always cleared, even if the API throws an error
                isFinished = true; 
                clearInterval(editInterval);
                clearInterval(typingInterval);
            }
        }
    },
};