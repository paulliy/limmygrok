const { Events, Collection } = require('discord.js');
const { parseimgs } = require('../utils/parseimgs');
const { safeError } = require('../utils/log');
const { conversationText } = require('../utils/prompt');
const { generateReply } = require('../utils/reply');
const { recordMessage } = require('../utils/corpus');
const { readTurns, writeTurns } = require('../utils/memory');
const { isDirectlyAddressed, addressReason, aliasesFor } = require('../utils/triggers');
const { createStreamAnimator, INITIAL_LOADING_TEXT } = require('../utils/streamingReply');

// Direct-address handler: @mentions, replies to the bot, and plain use of its
// name. Fires in any channel regardless of the auto-response allowlist —
// someone talking straight to the bot always gets an answer. Ambient chatter
// is events/messageStore.js's job. Generation itself lives in utils/reply.js,
// shared with the ambient path.

const MENTION_COOLDOWN_SECONDS = 5;

// How many turns a direct address sends the model. Deliberately tighter than
// the memory window: a direct question is a focused, in-the-moment ask, so
// recent context keeps the reply on topic. (Ambient replies use the full
// window; that difference is by design.)
const MENTION_CONTEXT_TURNS = 5;

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

// Per-user rate limit, sharing the client-wide cooldown collection the slash
// commands use. Returns false when this user is still inside the window.
function claimCooldown(client, userId) {
    const { cooldowns } = client;
    if (!cooldowns.has('mention')) cooldowns.set('mention', new Collection());

    const timestamps = cooldowns.get('mention');
    const now = Date.now();
    const cooldownMs = MENTION_COOLDOWN_SECONDS * 1000;

    if (timestamps.has(userId) && now < timestamps.get(userId) + cooldownMs) {
        return false;
    }

    timestamps.set(userId, now);
    setTimeout(() => timestamps.delete(userId), cooldownMs);
    return true;
}

// Appends this turn to memory, replacing rather than duplicating when the
// ambient listener already stored the very same message.
function recordUserTurn(client, message, userTurn) {
    const history = readTurns(client, message.channel.id);
    const last = history[history.length - 1];

    let lastText = '';
    if (last?.role === 'user') {
        if (typeof last.content === 'string') {
            lastText = last.content;
        } else if (Array.isArray(last.content)) {
            lastText = last.content.find((part) => part?.type === 'text')?.text || '';
        }
    }

    // Only dedup when the stored entry is genuinely THIS turn (exact raw
    // content). Matching on a bare bot-id substring would wrongly overwrite an
    // unrelated earlier message that merely mentions the bot.
    const isSameTurn = last?.role === 'user' && lastText === message.content;
    const next = isSameTurn ? [...history.slice(0, -1), userTurn] : [...history, userTurn];

    return writeTurns(client, message.channel.id, next);
}

module.exports = {
    name: Events.MessageCreate,
    once: false,
    async execute(message) {
        if (message.author.bot) return;
        if (!isDirectlyAddressed(message)) return;

        const client = message.client;
        if (!claimCooldown(client, message.author.id)) return;

        await message.channel.sendTyping();
        const typingInterval = setInterval(() => message.channel.sendTyping(), 8_000);

        let replyMessage;
        try {
            const messageContent = stripAddressing(message);

            // Reuse the same attachment/raw-URL image detection as the rest of
            // the bot, but on the addressing-stripped text. author/member are
            // passed through so these turns get the same "Name: text" speaker
            // prefix as ambient turns.
            const parsed = parseimgs({
                role: 'user',
                content: messageContent,
                attachments: message.attachments,
                author: message.author,
                member: message.member,
            });

            if (parsed.length === 0) {
                await message.reply('Ask me smth chud...');
                return;
            }

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

            const history = recordUserTurn(client, message, parsed[0]);
            const turns = parseimgs(history.slice(-MENTION_CONTEXT_TURNS));

            replyMessage = await message.reply(INITIAL_LOADING_TEXT);

            // Start the animation before the request so the loading phrases
            // run while it is in flight.
            const animator = createStreamAnimator({
                edit: (chunk) => replyMessage.edit(chunk),
            });

            // Retrieval runs on the last few turns, not just this message: a
            // pronoun-only question ("what does he think about that") carries
            // no retrievable signal on its own, and the turns around it are
            // usually what name who "he" is.
            await generateReply({
                client,
                message,
                turns,
                queryText: conversationText(turns) || messageContent,
                replyMessage,
                animator,
                statsType: 'mention',
                statsMeta: { name: addressReason(message), userId: message.author.id },
                label: 'MENTION',
            });
        } catch (error) {
            // Only reaches here for failures before generation starts —
            // utils/reply.js renders its own errors into the reply.
            safeError('[MENTION] Failed before generation:', error);
            if (replyMessage) {
                await replyMessage.edit('Something went wrong.').catch(() => {});
            }
        } finally {
            clearInterval(typingInterval);
        }
    },
};
