/**
 * Sequential thinking, reply formatting and the GPU-only engine choice.
 *
 * What these pin: a message is classified the same way every time, in English
 * and Romanian; a plan is read only from a numbered list; a step is shown the
 * end of the earlier steps' work; replies split into text and fenced code
 * exactly; a request can only shorten the profile's reply limit; and a
 * CPU-emulated WebGPU adapter is never used, on the page or in the worker.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyIntent, formatPlan, parsePlan, stepMessage, tailTokens } from '../src/webllm/webllmThinking.js';
import { estimateTokens } from '../src/webllm/webllmProgress.js';
import { safeLanguage, splitReply } from '../src/ui/webllm/replyFormat.js';
import { replyLimit } from '../src/webllm/webllmEngineHost.js';
import { detectWebGPU } from '../src/webllm/webgpuSupport.js';
import { createEngineClient, createWorkerTransport } from '../src/webllm/WebLLMEngineClient.js';
import { classifyError } from '../src/webllm/webllmProgress.js';

test('informative questions and productive requests are told apart, in English and Romanian', () => {
    const informative = [
        'hello',
        'What is a closure?',
        'How do I create an array?',
        'Explain how to build a component',
        'Which browsers support :has()?',
        'Ce este flexbox?',
        'Cum funcționează fetch?',
        'Write a long essay about the ocean'
    ];
    const productive = [
        'Create a login form with validation',
        'write a debounce function',
        'Can you build a todo app?',
        'Fix this code: ```js\nlet a\n```',
        'Scrie-mi o funcție JS care sortează un array',
        'Creează o pagină de login cu validare',
        'Te rog generează un formular de contact'
    ];
    for (const text of informative) assert.equal(classifyIntent(text), 'informative', text);
    for (const text of productive) assert.equal(classifyIntent(text), 'productive', text);
});

test('a plan is read only from list items, deduplicated and capped', () => {
    assert.deepEqual(
        parsePlan(
            'Here is the plan:\n1. Create the HTML form\n2) **Add** CSS styles\n- Validate with `JS`\n4. Ship it',
            3
        ),
        ['Create the HTML form', 'Add CSS styles', 'Validate with JS']
    );
    assert.deepEqual(parsePlan('Step 1: Markup\nStep 2: Styles', 4), ['Markup', 'Styles']);
    assert.deepEqual(parsePlan('1. Same\n2. same', 4), [], 'one distinct step is no plan');
    assert.deepEqual(parsePlan('Sure! Let me write it.', 4), []);
    assert.equal(formatPlan(['A', 'B']), '**Plan**\n1. A\n2. B');
});

test('a step sees the task, the plan and the end of the work before it', () => {
    const previous = `intro\n\`\`\`js\n${'line();\n'.repeat(400)}\`\`\``;
    const message = stepMessage({ task: 'Build it', steps: ['One', 'Two'], index: 1, previous, previousTokens: 60 });
    assert.match(message, /^Task: Build it\n\nPlan:\n1\. One\n2\. Two\n\n/);
    assert.match(message, /Now do step 2 only: Two$/);
    const done = message.match(/"""\n([\s\S]*)\n"""/)[1];
    assert.ok(estimateTokens(done) <= 70, 'only the end of the earlier work');
    assert.ok(done.startsWith('…\n```'), 'a tail that starts inside a code block reopens it');
    assert.equal(
        stepMessage({ task: 'Do it', steps: ['Do it'], index: 0, previous: '', previousTokens: 100 }),
        'Do it'
    );
    assert.equal(tailTokens('short', 100), 'short');
});

test('a reply splits into text and fenced code, an unfinished fence included', () => {
    assert.deepEqual(splitReply('Plain text\nwith lines'), [{ type: 'text', text: 'Plain text\nwith lines' }]);
    assert.deepEqual(splitReply('Before:\n\n```JavaScript\nconst a = 1;\n```\n\nAfter.'), [
        { type: 'text', text: 'Before:' },
        { type: 'code', lang: 'javascript', code: 'const a = 1;', closed: true },
        { type: 'text', text: 'After.' }
    ]);
    assert.deepEqual(splitReply('Streaming:\n```css\n.a {'), [
        { type: 'text', text: 'Streaming:' },
        { type: 'code', lang: 'css', code: '.a {', closed: false }
    ]);
    // A shorter fence inside a longer one is code.
    assert.deepEqual(splitReply('````md\n```js\nx\n```\n````'), [
        { type: 'code', lang: 'md', code: '```js\nx\n```', closed: true }
    ]);
    assert.equal(safeLanguage('js" onload="x'), 'jsonloadx');
});

test('a request can only shorten the profile’s reply limit', () => {
    assert.equal(replyLimit(null, 360), 360);
    assert.equal(replyLimit(256, 360), 256);
    assert.equal(replyLimit(256, 120), 120);
    assert.equal(replyLimit(null, undefined), null);
    assert.equal(replyLimit(256, -5), 256);
});

test('a CPU-emulated WebGPU adapter is reported unsupported, with its own advice', async () => {
    const requested = [];
    const nav = (adapter) => ({
        gpu: {
            requestAdapter: async (options) => {
                requested.push(options);
                return adapter;
            }
        }
    });
    const fallback = await detectWebGPU(nav({ isFallbackAdapter: true, info: {}, limits: {}, features: new Set() }));
    assert.equal(fallback.supported, false);
    assert.equal(fallback.fallbackAdapter, true);
    assert.deepEqual(requested[0], { powerPreference: 'high-performance', forceFallbackAdapter: false });

    const real = await detectWebGPU(nav({ info: { vendor: 'acme' }, limits: {}, features: new Set() }));
    assert.equal(real.supported, true);

    const advice = classifyError({ name: 'WebGPUFallbackAdapterError', message: 'software' });
    assert.equal(advice.kind, 'unsupported');
    assert.match(advice.message, /hardware acceleration/);
});

test('a worker that only has a CPU adapter is dropped, and the page is used from then on', async () => {
    class FakeWorker extends EventTarget {
        constructor(hello) {
            super();
            setTimeout(() => this.dispatchEvent(Object.assign(new Event('message'), { data: hello })), 0);
        }
        postMessage() {}
        terminate() {}
    }
    let noGpu = 0;
    const cpuOnly = { type: 'hello', webgpu: true, adapter: true, fallbackAdapter: true };
    assert.equal(await createWorkerTransport(() => new FakeWorker(cpuOnly), { onNoGpu: () => (noGpu += 1) }), null);
    assert.equal(noGpu, 1);
    const noAdapter = { type: 'hello', webgpu: true, adapter: false, fallbackAdapter: false };
    assert.equal(await createWorkerTransport(() => new FakeWorker(noAdapter)), null);

    const page = () => ({ kind: 'page', post() {}, onMessage() {}, onCrash() {}, terminate() {} });
    const told = await createEngineClient({
        workerTransport: async ({ onNoGpu }) => {
            onNoGpu();
            return null;
        },
        pageTransport: page
    });
    assert.equal(told.kind, 'page');
    assert.equal(told.workerHasNoGpu, true);

    let asked = 0;
    const remembered = await createEngineClient({
        preferred: 'page',
        workerTransport: async () => {
            asked += 1;
            return null;
        },
        pageTransport: page
    });
    assert.equal(remembered.kind, 'page');
    assert.equal(asked, 0, 'the worker is not asked again');
});

test('where the engine ran is remembered with the chat settings and asked for next time', async () => {
    const { WebLLMController } = await import('../src/webllm/WebLLMController.js');
    const saved = new Map();
    const store = {
        async getSettings() {
            return { retention: '7d', mdnEnabled: true, engine: saved.get('engine') ?? null };
        },
        async setSetting(key, value) {
            saved.set(key, value);
        },
        async listConversations() {
            return [];
        },
        close() {}
    };
    const preferredSeen = [];
    const start = async (engineKind, workerHasNoGpu) => {
        const controller = new WebLLMController({
            detectWebGPU: async () => ({ supported: true }),
            swClient: { status: async () => null, prepareLibrary: async () => ({}), clearModel: async () => ({}) },
            createEngine: async ({ preferred }) => {
                preferredSeen.push(preferred);
                return {
                    kind: engineKind,
                    workerHasNoGpu,
                    load: async () => ({}),
                    interrupt() {},
                    dispose() {}
                };
            },
            openHistory: async () => store
        });
        controller.setAllowed(true, { walletAddress: '0xabc' });
        while (controller.state.history !== 'ready') await new Promise((resolve) => setTimeout(resolve, 0));
        await controller.activate();
        await controller.install();
        return controller;
    };

    const first = await start('page', true);
    assert.equal(first.state.engineKind, 'page');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saved.get('engine'), 'page');

    await start('page', false);
    assert.deepEqual(preferredSeen, [null, 'page']);
});
