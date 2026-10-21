/**
 * Recognising a reply that has fallen into a loop — and leaving alone
 * everything that only looks like one.
 *
 * Both halves matter: the guard exists to end "hey" → the same sentence until
 * somebody presses Stop, and it must not cut off a list, a table rule, a row
 * of code or a reply the user explicitly asked to repeat.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { asksForRepetition, createLoopGuard, detectLoop } from '../src/webllm/webllmLoopGuard.js';

const rep = (text, times, separator = ' ') => Array(times).fill(text).join(separator);

/** Feed text to a guard the way a stream does, a few characters at a time. */
function stream(text, options, size = 4) {
    const guard = createLoopGuard(options);
    for (let at = 0; at < text.length; at += size) {
        const verdict = guard.push(text.slice(at, at + size));
        if (verdict) return { verdict, at: at + size, text: guard.text };
    }
    return null;
}

test('the reported shape: a greeting answered with one sentence, again and again', () => {
    const text = "Hey! How's it going? " + rep("Hey! How's it going? I'm here to help you with anything you need.", 6);
    const found = detectLoop(text);
    assert.ok(found);
    assert.equal(found.reason, 'cycle');
    // The first answer is kept, once; every repeat after it is dropped.
    assert.equal(
        text.slice(0, found.keepChars),
        "Hey! How's it going? Hey! How's it going? I'm here to help you with anything you need."
    );
});

test('one sentence three times in a row is a loop, however it is separated', () => {
    for (const separator of [' ', '\n', '\n\n']) {
        const sentence = "I'm here to help you with anything you need.";
        const found = detectLoop(`${rep(sentence, 3, separator)}${separator}`);
        assert.equal(found?.reason, 'cycle', JSON.stringify(separator));
    }
    // Case and punctuation do not make a repeat a new sentence.
    assert.equal(detectLoop('I can help with that. i can help with that! I can help with that? ')?.reason, 'cycle');
});

test('a question-and-answer cycle is found, wherever it starts', () => {
    const text = 'Sure thing. ' + rep('Hello! How can I assist you today?', 4) + ' ';
    const found = detectLoop(text);
    assert.equal(found?.reason, 'cycle');
    assert.equal(text.slice(0, found.keepChars), 'Sure thing. Hello! How can I assist you today?');
});

test('a long sentence that keeps coming back is circling, even with other text between', () => {
    const line = 'I can answer questions about many different topics.';
    const text = [
        'I can help.',
        line,
        'Ask away.',
        line,
        'Go ahead.',
        line,
        'Really.',
        line,
        'Sure.',
        line,
        'Yes.',
        line,
        'Done.'
    ].join(' ');
    const found = detectLoop(text);
    assert.equal(found?.reason, 'circling');
    assert.equal(text.slice(0, found.keepChars), `I can help. ${line} Ask away.`);
});

test('a loop that never forms a sentence is found by its period, and cut at a word', () => {
    const text = 'Let me think about that. ' + rep('and then the fox said hello to the dog', 6);
    const found = detectLoop(text);
    assert.equal(found?.reason, 'period');
    const kept = text.slice(0, found.keepChars);
    assert.ok(kept.startsWith('Let me think about that.'));
    assert.ok(kept.endsWith('hello to the dog'), kept);
    assert.ok(kept.length < text.length / 2);

    // Even a single repeated syllable, once it has gone on long enough to be a loop.
    assert.equal(detectLoop(rep('ha', 100, ''))?.reason, 'period');
});

test('a cut never lands inside a word', () => {
    const text = 'Sure thing. Here is a thought. ' + rep('I am a large language model, here to assist.', 3);
    const found = detectLoop(text);
    assert.ok(found);
    assert.ok(text.slice(0, found.keepChars).endsWith('assist.'));
});

test('streaming: the loop is caught within a few repeats, not after pages of text', () => {
    const text = "Hey! How's it going? " + rep("Hey! How's it going?", 12);
    const tripped = stream(text);
    assert.ok(tripped);
    assert.ok(tripped.at < 100, `caught after ${tripped.at} characters`);
    assert.equal(tripped.verdict.reason, 'cycle');
    // Once found, it stays found and nothing more is read.
    const guard = createLoopGuard();
    let verdict = null;
    for (let at = 0; at < text.length; at += 4) verdict = guard.push(text.slice(at, at + 4)) || verdict;
    assert.equal(guard.push('more'), verdict);
});

test('ordinary repetition is left alone', () => {
    const fine = {
        'a word said several times': 'No no no no no, I really mean it.',
        'short sentences': 'Yes. Yes. Yes. Absolutely yes, that works for me and everyone else.',
        laughing: 'Ha ha ha ha, that is a funny joke you told me today, thank you.',
        'a numbered list': '1. Eat well.\n2. Sleep well.\n3. Drink water.\n4. Walk daily.\n5. Read often.',
        'list items that share a start':
            'Steps:\n- Mix the flour and the eggs.\n- Mix the sugar and the butter.\n- Mix the milk and the salt.\n- Bake it.',
        'a table with rules': '| a | b |\n| --- | --- |\n| 1 | 2 |\n| --- | --- |\n| 3 | 4 |\n| --- | --- |\n| 5 | 6 |',
        'a long rule line': `Title\n${'-'.repeat(120)}\nBody text that is quite normal and not repeated at all here.`,
        'sentences that begin alike':
            'I think that is right. I think so too. I think we agree. I think it works. I think that is all.',
        prose:
            'WebGPU is a modern graphics API. It lets web pages use the GPU for rendering and compute. ' +
            'That matters for running models locally, because inference is mostly matrix math.'
    };
    for (const [name, text] of Object.entries(fine)) {
        assert.equal(detectLoop(text), null, name);
        assert.equal(stream(text, undefined, 3), null, `${name} (streamed)`);
    }
});

test('code is not read as prose: repeated lines are fine, a runaway is not', () => {
    const fine =
        '```js\nfor (let i = 0; i < 3; i++) {\n  console.log(i);\n  console.log(i);\n  console.log(i);\n}\n```\nThat prints each number thrice.';
    assert.equal(detectLoop(fine), null);

    const list =
        '```html\n<ul>\n' + ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((n) => `<li>${n}</li>`).join('\n');
    assert.equal(detectLoop(list), null);

    // The same line again and again, with no end in sight, is a loop even in a fence.
    const runaway = 'Here:\n```js\n' + rep('console.log("step");', 16, '\n');
    const found = detectLoop(runaway);
    assert.equal(found?.reason, 'period');
    assert.ok(runaway.slice(0, found.keepChars).endsWith('console.log("step");'));
});

test('a reply the user asked to be repeated is not cut off', () => {
    const text = rep('Hello world today friend.', 5) + ' ';
    assert.equal(detectLoop(text)?.reason, 'cycle');
    assert.equal(detectLoop(text, { allowRepeats: true }), null);

    assert.equal(asksForRepetition('say hello five times'), true);
    assert.equal(asksForRepetition('write a chorus for my song'), true);
    assert.equal(asksForRepetition('repeat after me'), true);
    assert.equal(asksForRepetition('write me a song about the sea'), true);
    assert.equal(asksForRepetition('a poem for my mum'), true);
    assert.equal(asksForRepetition('hey'), false);
    assert.equal(asksForRepetition('what is the capital of France?'), false);
    assert.equal(asksForRepetition(undefined), false);

    // Relaxed is not off: a model that never stops is still stopped.
    assert.equal(detectLoop(rep('Hello world today friend.', 40) + ' ', { allowRepeats: true })?.reason, 'cycle');
});

test('a song’s chorus coming back is form, not a loop', () => {
    const chorus = 'We will rock you, rock you tonight.';
    const song = [
        'Verse one: the road is long and the night is cold.',
        chorus,
        chorus,
        'Verse two: the sun will rise on the hills of gold.',
        chorus,
        chorus,
        'Verse three: we carry on until we are home.',
        chorus,
        ''
    ].join('\n');
    // Five appearances of one line is not enough to call it circling...
    assert.equal(detectLoop(song), null);
    // ...and when the user asked for a song the thresholds are lifted entirely.
    assert.equal(detectLoop(`${song}${song}`, { allowRepeats: true }), null);
});

test('text too short to be a loop is never one, and checks are cheap enough to run while streaming', () => {
    assert.equal(detectLoop(''), null);
    assert.equal(detectLoop('ha ha ha'), null);
    assert.equal(detectLoop(undefined), null);

    const long = 'lorem ipsum dolor sit amet, '.repeat(50);
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) detectLoop(`${long}${i}`);
    assert.ok(performance.now() - started < 500, 'a 1.4 KB reply is checked in well under a millisecond');
});
