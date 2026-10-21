/**
 * Reading WebLLM's progress reports and errors.
 *
 * The phases only show in the report text, so these use the exact phrases the
 * pinned `@mlc-ai/web-llm@0.2.85` writes, and a phrase it does not know falls
 * back to generic initialisation instead of breaking the progress card.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyError,
    describeProgress,
    estimateTokens,
    parseInitProgress,
    selectContextMessages,
    trimHistory
} from '../src/webllm/webllmProgress.js';
import {
    WEBLLM_CONTEXT_SAFETY_TOKENS,
    WEBLLM_CONTEXT_WINDOW,
    WEBLLM_GENERATION,
    WEBLLM_PROMPT_TOKEN_BUDGET
} from '../src/webllm/webllmConfig.js';

test('a download report gives the real percentage and megabytes', () => {
    const progress = parseInitProgress({
        progress: 0.4312,
        text:
            'Fetching param cache[9/22]: 307MB fetched. 43% completed, 12 secs elapsed. ' +
            'It can take a while when we first visit this page to populate the cache. Later refreshes will become faster.'
    });
    assert.equal(progress.phase, 'download');
    assert.equal(progress.percent, 43);
    assert.equal(progress.loadedMB, 307);
    assert.equal(progress.totalMB, 712);
    assert.equal(progress.shard, 9);
    assert.equal(progress.shards, 22);
    assert.equal(describeProgress(progress), 'Downloading model · 307 of 712 MB');
});

test('loading from the cache and compiling shaders are initialisation, not download', () => {
    const cached = parseInitProgress({
        progress: 0.5,
        text: 'Loading model from cache[11/22]: 356MB loaded. 50% completed, 2 secs elapsed.'
    });
    assert.equal(cached.phase, 'cache');
    assert.equal(cached.percent, 50);
    assert.equal(describeProgress(cached), 'Loading weights onto the GPU');

    const shaders = parseInitProgress({
        progress: 0.25,
        text: 'Loading GPU shader modules[20/80]: 25% completed, 1 secs elapsed.'
    });
    assert.equal(shaders.phase, 'shaders');
    assert.equal(shaders.percent, 25);

    assert.equal(parseInitProgress({ progress: 0, text: 'Start to fetch params' }).phase, 'download');
    assert.equal(parseInitProgress({ progress: 1, text: 'Finish loading on WebGPU - apple' }).phase, 'done');
});

test('an unknown report degrades to initialisation and a clamped percentage', () => {
    const progress = parseInitProgress({ progress: 3, text: 'Something new upstream' });
    assert.equal(progress.phase, 'init');
    assert.equal(progress.percent, 100);
    assert.equal(parseInitProgress({}).percent, 0);
});

test('errors are classified into what the user can do about them', () => {
    assert.equal(classifyError({ name: 'WebGPUNotAvailableError', message: '' }).kind, 'unsupported');
    assert.equal(classifyError({ name: 'WebGPUNotAvailableError', message: '' }).retryable, false);
    assert.equal(classifyError({ name: 'ShaderF16SupportError', message: '' }).kind, 'unsupported');
    assert.equal(classifyError({ name: 'DeviceLostError', message: '' }).kind, 'resources');
    assert.equal(classifyError({ name: 'WorkerCrashed', message: 'may have run out of memory' }).kind, 'resources');
    assert.equal(classifyError({ name: 'QuotaExceededError', message: '' }).kind, 'storage');
    assert.equal(classifyError({ name: 'TypeError', message: 'Failed to fetch' }).kind, 'network');
    // What WebLLM's Cache API path throws when a download answers with an HTTP error.
    assert.equal(
        classifyError({ name: 'TypeError', message: "Failed to execute 'add' on 'Cache': Request failed" }).kind,
        'network'
    );
    assert.equal(classifyError({ name: 'ContextWindowSizeExceededError', message: '' }).kind, 'context');
    const unknown = classifyError({ name: 'Error', message: 'boom' });
    assert.equal(unknown.kind, 'unknown');
    assert.equal(unknown.retryable, true);
    assert.equal(unknown.detail, 'boom');
});

test('token estimates err high for prose and code, and count non-ASCII text at more than one token per character', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('hey'), 1);
    // Llama 3 averages ~4 characters per token on prose and ~3 on code: never undercounted.
    const prose = 'WebGPU lets web pages use the graphics card for general computation. '.repeat(20);
    assert.ok(estimateTokens(prose) >= prose.length / 4);
    const code = 'for (let i = 0; i < n; i++) { total += values[i] * weights[i]; }\n'.repeat(10);
    assert.ok(estimateTokens(code) >= code.length / 3);
    assert.ok(estimateTokens('你好，世界') >= 5 * 1.5);
});

const turn = (role, chars) => ({ role, content: 'x'.repeat(chars) });

test('trimming keeps the system prompt and the newest message, and drops the oldest exchanges first', () => {
    const messages = [
        { role: 'system', content: 'S' },
        turn('user', 300),
        turn('assistant', 300),
        turn('user', 300),
        turn('assistant', 300),
        { role: 'user', content: 'latest question' }
    ];
    // Each 300-character turn is ~105 tokens with its framing.
    const all = trimHistory(messages, { budget: 10000 });
    assert.equal(all.messages.length, 6);
    assert.equal(all.dropped, 0);
    assert.equal(all.fits, true);

    const trimmed = trimHistory(messages, { budget: 280 });
    assert.deepEqual(
        trimmed.messages.map((message) => message.role),
        ['system', 'user', 'assistant', 'user']
    );
    assert.equal(trimmed.messages.at(-1).content, 'latest question');
    assert.equal(trimmed.dropped, 2);
    assert.ok(trimmed.tokens <= 280, `${trimmed.tokens} tokens in a 280 budget`);
});

test('a trimmed conversation never starts on a reply to a question that was cut', () => {
    const messages = [
        { role: 'system', content: 'S' },
        turn('user', 3000),
        turn('assistant', 30),
        { role: 'user', content: 'next' }
    ];
    // The reply fits but its question does not: the reply goes with it.
    const trimmed = trimHistory(messages, { budget: 120 });
    assert.deepEqual(
        trimmed.messages.map((message) => message.role),
        ['system', 'user']
    );
    assert.equal(trimmed.dropped, 2);
    assert.ok(trimmed.tokens <= 120);
});

test('a newest message too big for the window is reported, not silently sent', () => {
    const trimmed = trimHistory(
        [
            { role: 'system', content: 'S' },
            { role: 'user', content: 'y'.repeat(20000) }
        ],
        { budget: 3520 }
    );
    assert.equal(trimmed.fits, false);
    assert.equal(trimmed.messages.at(-1).content.length, 20000);
});

test('the prompt budget leaves the reply and a margin inside the 4096-token window', () => {
    assert.equal(
        WEBLLM_PROMPT_TOKEN_BUDGET + WEBLLM_GENERATION.max_tokens + WEBLLM_CONTEXT_SAFETY_TOKENS,
        WEBLLM_CONTEXT_WINDOW
    );
    assert.equal(WEBLLM_CONTEXT_WINDOW, 4096);
    // A conversation that overflows is cut to the budget, estimated framing included.
    const long = [{ role: 'system', content: 'S' }];
    for (let i = 0; i < 60; i += 1) long.push(turn(i % 2 ? 'assistant' : 'user', 600));
    long.push({ role: 'user', content: 'now' });
    const trimmed = trimHistory(long);
    assert.ok(trimmed.tokens <= WEBLLM_PROMPT_TOKEN_BUDGET);
    assert.ok(trimmed.dropped > 0);
});

test('only finished exchanges are passed back as context', () => {
    const exchange = (id, extra) => [
        { role: 'user', content: `question ${id}`, pending: false, error: null, stopped: false },
        { role: 'assistant', content: `answer ${id}`, pending: false, error: null, stopped: false, ...extra }
    ];
    const messages = [
        ...exchange(1, { finishReason: 'stop' }),
        ...exchange(2, { finishReason: 'abort', stopped: true }),
        ...exchange(3, { finishReason: 'loop' }),
        ...exchange(4, { finishReason: 'error', error: 'It broke', content: '' }),
        ...exchange(5, { finishReason: 'length' }),
        // Still being written: not context yet.
        ...exchange(6, { finishReason: null, pending: true }),
        // Nothing came back at all.
        ...exchange(7, { finishReason: 'stop', content: '  ' })
    ];
    assert.deepEqual(selectContextMessages(messages), [
        { role: 'user', content: 'question 1' },
        { role: 'assistant', content: 'answer 1' },
        { role: 'user', content: 'question 5' },
        { role: 'assistant', content: 'answer 5' }
    ]);
    assert.deepEqual(selectContextMessages([]), []);
});
