'use strict';

// The one path from "we have decided to say something" to "it is on screen".
//
// Both reply triggers — a direct address (events/mention.js) and the ambient
// counter (events/autoresponce.js) — used to carry their own copy of this
// sequence: build the learned context, pick a model, stream, enforce the
// server's voice, maybe garnish with a GIF, record the event, remember what
// was said. Roughly seventy identical lines each.
//
// Keeping them in sync was the actual cost. Four separate changes in this
// module's history — the voice filter, per-request model routing, GIF
// garnish, and the privacy config — each had to be made twice, and a fifth
// that got made only once would have been a silent behavioural split between
// "the bot replying to you" and "the bot chiming in".
//
// What stays with the callers is what genuinely differs: how the trigger
// fires, what context it assembles, its cooldown, and its typing indicator.

const { resolveConfig } = require('./config');
const { resolveImageUrlsToBase64 } = require('./parseimgs');
const { safeError, debugLog } = require('./log');
const { requestChatCompletion, describeLlmError, pickModel } = require('./llm');
const { buildReplyContext } = require('./prompt');
const { applyServerVoice, samplingParamsFor } = require('./voice');
const { pickGarnishGif } = require('./media');
const { recordEvent } = require('./stats');
const { appendTurn } = require('./memory');
const { stripThinkAndCitations, withGarnish } = require('./streamingReply');

const fallbackConfig = resolveConfig() || {};

const THINKING_ONLY_NOTICE = 'The model only returned thinking content with no final response.';

// Reads the stream (or the non-streaming fallback) into the animator, and
// reports why generation stopped so a reply cut off mid-word can be trimmed
// rather than posted as a fragment.
async function consumeCompletion(completion, animator) {
    let finishReason = null;

    if (completion.isStream) {
        for await (const chunk of completion.stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) animator.append(delta);
            finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
        }
    } else {
        animator.append(completion.response?.choices?.[0]?.message?.content || '');
        finishReason = completion.response?.choices?.[0]?.finish_reason ?? null;
    }

    return finishReason;
}

// Generates one reply and edits it into `replyMessage`.
//
// `turns` are the already-parsed conversation turns to send; `queryText` is
// what precedent and GIF retrieval are matched against. The caller owns
// creating `replyMessage` and `animator` so each trigger keeps its own
// loading UX.
//
// Errors are handled here rather than rethrown: every caller did the same
// three things with them (stop the animator, log scrubbed, show the
// user-facing sentence). Returns the delivered text, or null if nothing was
// sent.
async function generateReply({
    client,
    message,
    turns,
    queryText,
    replyMessage,
    animator,
    statsType,
    statsMeta = {},
    label = 'REPLY',
}) {
    const llmConfig = client.config || fallbackConfig;
    const channelId = message.channel.id;

    try {
        // The learned server dialect + precedent retrieved for whatever is
        // being responded to. This is what makes the reply sound like the
        // server rather than like a model.
        const { systemPrompt, profile } = buildReplyContext({
            db: client.db,
            guildId: message.guildId,
            queryText,
        });

        debugLog(`[${label}] system prompt:`, systemPrompt);

        const payloadMessages = [
            { role: 'system', content: systemPrompt },
            ...(await resolveImageUrlsToBase64(turns)),
        ];

        const completion = await requestChatCompletion(client.llm, {
            // Text-only model for ordinary chat, vision model only when an
            // image is actually present.
            model: pickModel(llmConfig, payloadMessages),
            messages: payloadMessages,
            stream: true,
            ...samplingParamsFor(profile),
        }, { config: llmConfig });

        const finishReason = await consumeCompletion(completion, animator);
        animator.finish();

        // Prompting asked for the server's voice; this enforces it.
        const finalContent = applyServerVoice(
            stripThinkAndCitations(animator.content),
            profile,
            { botName: client.user?.username, wasTruncated: finishReason === 'length' }
        );

        if (!finalContent) {
            await replyMessage.edit(THINKING_ONLY_NOTICE).catch(() => {});
            return null;
        }

        // Occasionally garnish with a GIF this server actually posts in
        // situations like this. Rare by design (see utils/media.js) — it
        // should land as a reaction, not a tic.
        const garnish = pickGarnishGif(client.db, message.guildId, queryText, {
            channelId,
            cooldowns: client.mediaCooldowns,
        });

        await replyMessage.edit(withGarnish(finalContent, garnish));

        if (statsType) {
            recordEvent(client, statsType, { guildId: message.guildId, channelId, ...statsMeta });
        }

        // Store the voiced text, not the raw model output, so the bot's own
        // prior turns stay in the server's register. The GIF URL is
        // deliberately left out — the model imitates what it sees, and it
        // starts inventing URLs.
        appendTurn(client, channelId, { role: 'assistant', content: finalContent });

        return finalContent;
    } catch (error) {
        animator.finish();
        safeError(`[${label}] LLM error:`, error);
        await replyMessage.edit(describeLlmError(error, llmConfig)).catch(() => {});
        return null;
    } finally {
        animator.finish();
    }
}

module.exports = { generateReply, consumeCompletion, THINKING_ONLY_NOTICE };
