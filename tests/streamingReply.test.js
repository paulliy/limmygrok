// Tests for the ANSI-colored loading placeholder in utils/streamingReply.js.
//
// Scope: only the loading/idle placeholder (shown before real model content
// arrives) is ANSI-fenced. Real streamed/final content must stay raw plain
// text — that's asserted explicitly below as a regression guard.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    LOADING_PHRASES,
    DOT_FRAMES,
    createStreamAnimator,
    formatAnsiLoadingLine,
    formatAnsiIdleText,
    INITIAL_LOADING_TEXT,
} = require('../utils/streamingReply');

const ESC = '';

function fenceAssertions(chunk) {
    assert.ok(chunk.startsWith('```ansi\n'), `expected ansi fence open, got: ${chunk}`);
    assert.ok(chunk.endsWith('\n```'), `expected ansi fence close, got: ${chunk}`);
    assert.ok(chunk.includes(ESC + '['), 'expected an ANSI escape sequence');
    assert.ok(chunk.includes(ESC + '[0m'), 'expected a reset code before the closing fence');
}

test('formatAnsiLoadingLine wraps phrase + dots in an ansi-fenced, colored line', () => {
    const chunk = formatAnsiLoadingLine('Pondering', ': :');
    fenceAssertions(chunk);
    assert.ok(chunk.includes('Pondering'));
    assert.ok(chunk.includes(': :'));
});

test('formatAnsiIdleText wraps static text in an ansi-fenced line with no markdown stars', () => {
    const chunk = formatAnsiIdleText('Thinking...');
    fenceAssertions(chunk);
    assert.ok(chunk.includes('Thinking...'));
    assert.ok(!chunk.includes('*'), 'markdown emphasis markers should not leak into the ansi block');
});

test('INITIAL_LOADING_TEXT is a stable, ansi-fenced constant built at module load', () => {
    assert.equal(typeof INITIAL_LOADING_TEXT, 'string');
    assert.ok(INITIAL_LOADING_TEXT.length > 0);
    fenceAssertions(INITIAL_LOADING_TEXT);
    assert.equal(INITIAL_LOADING_TEXT, formatAnsiIdleText('Thinking...'));
});

test('createStreamAnimator ticks show an ansi-fenced loading phrase when usePhrases is true', async () => {
    const edits = [];
    const animator = createStreamAnimator({
        edit: (chunk) => { edits.push(chunk); },
        intervalMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    animator.finish();

    assert.ok(edits.length > 0, 'expected at least one tick to have fired');
    const chunk = edits[0];
    fenceAssertions(chunk);
    assert.ok(LOADING_PHRASES.some((phrase) => chunk.includes(phrase)), 'expected a known loading phrase');
    assert.ok(DOT_FRAMES.some((dots) => chunk.includes(dots)), 'expected a known dot frame');
});

test('createStreamAnimator ticks show the ansi-fenced idle text when usePhrases is false', async () => {
    const edits = [];
    const animator = createStreamAnimator({
        edit: (chunk) => { edits.push(chunk); },
        usePhrases: false,
        intervalMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    animator.finish();

    assert.ok(edits.length > 0, 'expected at least one tick to have fired');
    assert.equal(edits[0], formatAnsiIdleText('Thinking...'));
});

test('regression: once real content has streamed in, ticks show raw unwrapped text (no ansi fence)', async () => {
    const edits = [];
    const animator = createStreamAnimator({
        edit: (chunk) => { edits.push(chunk); },
        intervalMs: 10,
    });

    animator.append('Hello, this is the real model response.');
    await new Promise((resolve) => setTimeout(resolve, 30));
    animator.finish();

    assert.ok(edits.length > 0, 'expected at least one tick to have fired');
    const chunk = edits[edits.length - 1];
    assert.equal(chunk, 'Hello, this is the real model response.');
    assert.ok(!chunk.includes('```ansi'), 'real content must not be ansi-fenced');
    assert.ok(!chunk.includes(ESC), 'real content must not contain ANSI escape codes');
});
