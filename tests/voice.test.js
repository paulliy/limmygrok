// Tests for utils/voice.js — the output-side enforcement of the server's
// measured habits. Prompting asks; this decides.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    applyServerVoice,
    stripAssistantTics,
    stripSpeakerPrefix,
    cutRolePlay,
    matchCase,
    matchPunctuation,
    trimDanglingSentence,
    samplingParamsFor,
} = require('../utils/voice');

// A server that types in lowercase and does not punctuate — the case the
// filter is built for.
const CASUAL = { lowercaseRatio: 0.93, punctuationRatio: 0.05, avgWords: 5 };
// A server that writes properly. Nothing should be rewritten for it.
const FORMAL = { lowercaseRatio: 0.1, punctuationRatio: 0.85, avgWords: 20 };

// --- assistant tics ----------------------------------------------------------

test('strips service-desk openers', () => {
    assert.equal(stripAssistantTics('Sure! Bawberry whiffed.'), 'Bawberry whiffed.');
    assert.equal(stripAssistantTics('Great question. He is bad.'), 'He is bad.');
    assert.equal(stripAssistantTics('Certainly, here you go.'), 'here you go.');
});

test('strips trailing offers of further assistance', () => {
    assert.equal(stripAssistantTics('he whiffed. Let me know if you need anything else!'), 'he whiffed.');
    assert.equal(stripAssistantTics('holding site. Hope that helps!'), 'holding site.');
    assert.equal(stripAssistantTics('yeah. Feel free to ask more questions.'), 'yeah.');
});

test('strips AI disclaimers wherever they appear', () => {
    assert.equal(stripAssistantTics('As an AI, I cannot judge. He is bad.'), 'He is bad.');
    assert.match(stripAssistantTics('I should note that this is subjective. bawberry whiffs'), /^bawberry whiffs$/);
});

test('stacked openers and closers are all removed', () => {
    const cleaned = stripAssistantTics('Sure! Great question. bawberry whiffs. Hope this helps!');
    assert.equal(cleaned, 'bawberry whiffs.');
});

test('ordinary chat is left alone', () => {
    for (const text of ['bawberry whiffed mid again', 'holding site lads', 'no']) {
        assert.equal(stripAssistantTics(text), text);
    }
});

// --- speaker prefixes and role-play -----------------------------------------

test('removes the bot signing its own name', () => {
    assert.equal(stripSpeakerPrefix('limmygrok: he whiffed', 'limmygrok'), 'he whiffed');
    assert.equal(stripSpeakerPrefix('LimmyGrok : he whiffed', 'limmygrok'), 'he whiffed');
    // Someone else's name is content, not a prefix to strip.
    assert.equal(stripSpeakerPrefix('bawberry: he whiffed', 'limmygrok'), 'bawberry: he whiffed');
});

test('cuts the model writing everyone else\'s replies', () => {
    const output = 'yeah he whiffed\nbawberry: no i didnt\nlimmy: lol';
    assert.equal(cutRolePlay(output), 'yeah he whiffed');
});

test('a colon inside a real sentence is not a speaker label', () => {
    const output = 'the plan is simple\nwe do the thing: win the round';
    assert.equal(cutRolePlay(output), output);
});

test('a leading speaker-looking line is kept (it is the reply itself)', () => {
    assert.equal(cutRolePlay('note: he whiffed'), 'note: he whiffed');
});

test('links are not mistaken for speaker labels', () => {
    const output = 'look at this\nhttps://example.com/thing';
    assert.equal(cutRolePlay(output), output);
});

// --- measured habits ---------------------------------------------------------

test('casing follows the server, in both directions', () => {
    assert.equal(matchCase('Bawberry Is Holding Site', CASUAL), 'bawberry is holding site');
    // A server that capitalises gets left alone entirely.
    assert.equal(matchCase('Bawberry Is Holding Site', FORMAL), 'Bawberry Is Holding Site');
    // So does one with no measurable habit.
    assert.equal(matchCase('Bawberry Is Holding', null), 'Bawberry Is Holding');
});

test('lowercasing preserves URLs, custom emoji and mentions', () => {
    const text = 'check https://Example.COM/Path and <:Limmy:123> and <@!456>';
    const result = matchCase(text, CASUAL);
    assert.ok(result.includes('https://Example.COM/Path'), 'URL case must survive');
    assert.ok(result.includes('<:Limmy:123>'), 'custom emoji name must survive');
    assert.ok(result.includes('<@!456>'), 'mention must survive');
    assert.ok(result.includes('check'));
});

test('lowercasing preserves code spans and blocks', () => {
    assert.equal(matchCase('use `const X = 1` here', CASUAL), 'use `const X = 1` here');
    const fenced = 'try\n```js\nconst X = 1;\n```';
    assert.ok(matchCase(fenced, CASUAL).includes('const X = 1;'));
});

test('numbers in the message are never eaten by the masking', () => {
    // Regression: digit-based placeholders collided with the message's own
    // numbers, so "i have 3 apples" lost the 3.
    assert.equal(matchCase('I have 3 apples and 12 oranges', CASUAL), 'i have 3 apples and 12 oranges');
    assert.equal(
        applyServerVoice('I have 3 apples and 12 oranges', { style: CASUAL }, {}),
        'i have 3 apples and 12 oranges'
    );
});

test('trailing full stops follow the server, but ? and ! never change', () => {
    assert.equal(matchPunctuation('he whiffed.', CASUAL), 'he whiffed');
    assert.equal(matchPunctuation('he whiffed?', CASUAL), 'he whiffed?');
    assert.equal(matchPunctuation('he whiffed!', CASUAL), 'he whiffed!');
    assert.equal(matchPunctuation('he whiffed...', CASUAL), 'he whiffed...');
    assert.equal(matchPunctuation('He whiffed.', FORMAL), 'He whiffed.');
});

test('truncated replies drop the dangling fragment', () => {
    assert.equal(trimDanglingSentence('he whiffed mid. then he went and', true), 'he whiffed mid.');
    // Not truncated: leave it exactly as-is.
    assert.equal(trimDanglingSentence('he whiffed mid. then he went and', false), 'he whiffed mid. then he went and');
    // Trimming that would gut the reply is skipped.
    assert.equal(trimDanglingSentence('a. bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', true), 'a. bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

// --- full pipeline -----------------------------------------------------------

test('the pipeline turns an assistant reply into a server message', () => {
    const modelOutput = 'Sure! Great question. Bawberry Is Holding Site Again. Let me know if you need anything else!';
    assert.equal(
        applyServerVoice(modelOutput, { style: CASUAL }, { botName: 'limmygrok' }),
        'bawberry is holding site again'
    );
});

test('the pipeline leaves a formal server\'s replies untouched', () => {
    const modelOutput = 'Bawberry is holding site again.';
    assert.equal(applyServerVoice(modelOutput, { style: FORMAL }, { botName: 'limmygrok' }), modelOutput);
});

test('the pipeline is safe with no profile at all', () => {
    // Before anything is learned, only the bot-agnostic cleanups apply.
    assert.equal(applyServerVoice('Sure! He whiffed.', null, {}), 'He whiffed.');
    assert.equal(applyServerVoice('', { style: CASUAL }, {}), '');
    assert.equal(applyServerVoice(null, { style: CASUAL }, {}), '');
    assert.equal(applyServerVoice(undefined, null, {}), '');
});

// --- sampling ----------------------------------------------------------------

test('token budget scales with the server\'s typical message length', () => {
    const terse = samplingParamsFor({ style: { avgWords: 4 } });
    const wordy = samplingParamsFor({ style: { avgWords: 60 } });
    assert.ok(wordy.max_tokens > terse.max_tokens, 'a wordier server gets more room');
    // Floor keeps a real answer possible; ceiling keeps replies chat-sized.
    assert.equal(terse.max_tokens, 120);
    assert.ok(wordy.max_tokens <= 500);
});

test('sampling defaults favour variety, and are overridable', () => {
    const params = samplingParamsFor(null);
    assert.ok(params.temperature >= 0.8, 'warm sampling keeps replies from going stock');
    assert.ok(params.presence_penalty > 0);
    assert.equal(samplingParamsFor(null, { temperature: 0.2 }).temperature, 0.2);
});
