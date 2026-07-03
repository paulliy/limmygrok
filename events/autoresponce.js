const { MODEL_NAME } = require('../config.json');

/**
 * Processes messages for the API by merging consecutive messages from the same role
 * and filtering out any empty messages. The OpenAI API requires roles to alternate
 * and for message content to be non-empty.
 * @param {Array<{role: string, content: string}>} messages The array of messages to process.
 * @returns {Array<{role: string, content: string}>} The processed messages.
 */
function processMessagesForApi(messages) {
    if (!messages || messages.length === 0) {
        return [];
    }

    const nonEmptyMessages = messages.filter((msg) => msg.content && msg.content.trim() !== '');
    if (nonEmptyMessages.length === 0) {
        return [];
    }

    const merged = [];
    let lastMessage = { ...nonEmptyMessages[0] };

    for (let i = 1; i < nonEmptyMessages.length; i++) {
        const currentMessage = nonEmptyMessages[i];
        if (currentMessage.role === lastMessage.role) {
            lastMessage.content += `\n${currentMessage.content}`;
        } else {
            merged.push(lastMessage);
            lastMessage = { ...currentMessage };
        }
    }
    merged.push(lastMessage);

    return merged;
}

async function generateAutoresponce(message) {
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const history = message.client.memory.get(channelId) || [];

    // Use the last 20 messages for context
    const contextMessages = history.slice(-20);

    if (contextMessages.length === 0) return;

    await message.channel.sendTyping();

    const openWebUI = message.client.openWebUI;
    let replyMessage = await message.reply('*Thinking.*');

    const loadingPhrases = [
        'Thinking', 'Pondering', 'Questing', 'Holding site',
        'Playing Valorant', 'Winning', 'Cooking', 'Strategizing',
        'Turtletiming', 'Coding', 'Synthizing', 'Baldliking',
        'Chudding', 'Meowling', 'Climbing rocks', 'Whiffing hard',
        'Bawberrying', 'Bankheading', 'Geneing', 'Limmying', 'Praying',
        'Five Stacking A', 'Dying mid', 'Eating Goldfish',
        'Saving the World', 'Plain Janing','Ai-ing','Listening to AJR',
        'Getting a new permit','Watching the sunset','Reading','Writing',
        'Exploring','Juggling','Watching cote','Holding mid',
        'Whiffing again','Full buying','Picking up the bomb','Defusing','Planting','Rotating',
        'Joining VC','Wordle streaking','Playing Smash','Creating Limmygrok','Deadlotting',
        'Queuing','Gooning','Mutting','Baiting','Boosting'
    ];
    let phraseIndex = Math.floor(Math.random() * loadingPhrases.length);
    let frameIndex = 0;
    const dotFrames = ['.', ':', ': .', ': :', ': : .',': : : .',': : : :'];

    console.log(`\n[DEBUG] --- AUTO-RESPONSE STREAM STARTED ---`);

    let content = '';
    let lastDisplayedContent = '*Thinking.*';
    let isEditing = false;
    let isFinished = false;

    // 1. Start the animation interval IMMEDIATELY
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
        const processedMessages = processMessagesForApi(contextMessages);

        if (processedMessages.length === 0) {
            isFinished = true;
            clearInterval(editInterval);
            await replyMessage.delete().catch(() => {}); // Clean up the "Thinking" message
            return;
        }

        const apiPayload = {
            model: MODEL_NAME,
            messages: [{ role: 'system', content: 'You are a helpful assistant in a Discord chat.' }, ...processedMessages],
            stream: true,
        };

        console.log(`\n[DEBUG] API Payload:`, JSON.stringify(apiPayload, null, 2));

        const stream = await openWebUI.chat.completions.create(apiPayload);

        for await (const chunk of stream) {
            const deltaContent = chunk.choices?.[0]?.delta?.content;
            if (deltaContent) {
                content += deltaContent;
                process.stdout.write(deltaContent);
            }
        }

        isFinished = true;
        console.log(`\n[DEBUG] --- AUTO-RESPONSE STREAM FINISHED ---`);

        const finalContent = content
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/\[\d+\]/g, '')
            .trim();

        const truncatedFinalContent = finalContent.length > 2000
            ? finalContent.slice(0, 1997) + '/...'
            : finalContent;

        if (!finalContent) {
            await replyMessage.edit('The model only returned thinking content with no final response.');
            return;
        }

        await replyMessage.edit(truncatedFinalContent);

        // Add the bot's final response to the memory
        let currentMemory = message.client.memory.get(message.channel.id) || [];
        currentMemory.push({ role: 'assistant', content: finalContent });
        if (currentMemory.length > 20) {
            currentMemory = currentMemory.slice(-20);
        }
        message.client.memory.set(message.channel.id, currentMemory);

        console.log(`\n[DEBUG] Updated Memory:`, JSON.stringify(currentMemory, null, 2));

    } catch (error) {
        console.error('OpenWebUI Error:', error);
        await replyMessage.edit(`Error: ${error.message ?? 'Something went wrong.'}`).catch(() => {});
    } finally {
        isFinished = true;
        clearInterval(editInterval);
    }
}

module.exports = { generateAutoresponce };
