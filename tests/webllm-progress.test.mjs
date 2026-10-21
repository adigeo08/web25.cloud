/**
 * Reading WebLLM's progress reports and errors.
 *
 * The phases only show in the report text, so these use the exact phrases the
 * pinned `@mlc-ai/web-llm@0.2.85` writes, and a phrase it does not know falls
 * back to generic initialisation instead of breaking the progress card.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyError, describeProgress, parseInitProgress, trimHistory } from '../src/webllm/webllmProgress.js';

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

test('history trimming keeps the system prompt and the newest turns, starting on a user turn', () => {
    const messages = [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'a'.repeat(50) },
        { role: 'assistant', content: 'b'.repeat(50) },
        { role: 'user', content: 'c'.repeat(50) },
        { role: 'assistant', content: 'd'.repeat(50) },
        { role: 'user', content: 'e'.repeat(10) }
    ];
    const trimmed = trimHistory(messages, 120);
    assert.deepEqual(
        trimmed.map((message) => message.content[0]),
        ['S', 'c', 'd', 'e']
    );
    // A single message larger than the budget is still sent.
    assert.equal(trimHistory([{ role: 'user', content: 'x'.repeat(500) }], 10).length, 1);
});
