const { parseimgs } = require('../utils/parseimgs');
const { safeError } = require('../utils/log');
const { conversationText } = require('../utils/prompt');
const { generateReply } = require('../utils/reply');
const { readTurns } = require('../utils/memory');
const { createStreamAnimator, INITIAL_LOADING_TEXT } = require('../utils/streamingReply');

// The ambient trigger: every N messages in an allowlisted channel, the bot
// chimes in unprompted. Generation itself lives in utils/reply.js, shared
// with the direct-address path.

async function generateAutoresponce(message) {
    if (message.author.bot) return;

    const client = message.client;
    const channelId = message.channel.id;

    // Ambient replies use the full memory window: unlike a direct question,
    // there is no single message being answered, so the reply is about
    // whatever the channel has been talking about.
    const turns = parseimgs(readTurns(client, channelId));
    if (turns.length === 0) return;

    await message.channel.sendTyping();

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

    await generateReply({
        client,
        message,
        turns,
        queryText: conversationText(turns),
        replyMessage,
        animator,
        statsType: 'autoresponse',
        label: 'AUTORESPONSE',
    });
}

module.exports = { generateAutoresponce };
