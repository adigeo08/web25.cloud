/**
 * The engine host and the page's client for it.
 *
 * The host is the only code that calls WebLLM, and it runs in the dedicated
 * worker. These drive it with a stand-in for the WebLLM module and check the
 * protocol end to end through the in-page transport, which is the same host
 * behind the same messages.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createEngineHost, loadWebLLMLibrary, matchesIntegrity } from '../src/webllm/webllmEngineHost.js';
import {
    createEngineClient,
    createPageTransport,
    createWorkerTransport,
    WebLLMEngineClient
} from '../src/webllm/WebLLMEngineClient.js';
import { WEBLLM_MODEL_ID, createAppConfig } from '../src/webllm/webllmConfig.js';

/** A stand-in for the `@mlc-ai/web-llm` module. */
function fakeWebLLM({ reloadDelay = 0, chunks = ['A', 'B'] } = {}) {
    const calls = { constructed: 0, reloads: [], unloads: 0, interrupts: 0, creates: [] };
    class MLCEngine {
        constructor(config) {
            calls.constructed += 1;
            calls.config = config;
            this.config = config;
            this.chat = {
                completions: {
                    create: async (request) => {
                        calls.creates.push(request);
                        return (async function* () {
                            for (const text of chunks) yield { choices: [{ delta: { content: text } }] };
                            yield {
                                choices: [{ delta: {}, finish_reason: 'stop' }],
                                usage: { completion_tokens: chunks.length }
                            };
                        })();
                    }
                }
            };
        }
        async reload(modelId) {
            calls.reloads.push(modelId);
            this.config.initProgressCallback({
                progress: 0.5,
                text: 'Fetching param cache[1/2]: 1MB fetched. 50% completed',
                timeElapsed: 1
            });
            await new Promise((resolve) => setTimeout(resolve, reloadDelay));
        }
        async unload() {
            calls.unloads += 1;
        }
        interruptGenerate() {
            calls.interrupts += 1;
        }
    }
    return { module: { MLCEngine }, calls };
}

test('one load at a time: concurrent loads share one engine and one download', async () => {
    const webllm = fakeWebLLM({ reloadDelay: 10 });
    let libraryLoads = 0;
    const posted = [];
    const host = createEngineHost({
        post: (message) => posted.push(message),
        loadLibrary: async () => {
            libraryLoads += 1;
            return webllm.module;
        }
    });

    await Promise.all([host.handle({ type: 'load', requestId: 1 }), host.handle({ type: 'load', requestId: 2 })]);
    assert.equal(libraryLoads, 1);
    assert.equal(webllm.calls.constructed, 1);
    assert.deepEqual(webllm.calls.reloads, [WEBLLM_MODEL_ID]);
    // The engine is given the pinned single-model config, on Cache Storage.
    assert.deepEqual(webllm.calls.config.appConfig, createAppConfig());
    assert.equal(webllm.calls.config.appConfig.cacheBackend, 'cache');

    const results = posted.filter((message) => message.type === 'result');
    assert.equal(results.length, 2);
    assert.ok(results.every((message) => message.ok));
    assert.ok(posted.some((message) => message.type === 'progress' && message.progress === 0.5));

    await host.handle({ type: 'load', requestId: 3 });
    assert.equal(posted.at(-1).value.alreadyLoaded, true);
});

test('a chat streams deltas over the protocol and uses the chat completions API', async () => {
    const webllm = fakeWebLLM({ chunks: ['Hel', 'lo'] });
    const posted = [];
    const host = createEngineHost({ post: (message) => posted.push(message), loadLibrary: async () => webllm.module });
    await host.handle({ type: 'load', requestId: 1 });
    await host.handle({ type: 'chat', requestId: 2, messages: [{ role: 'user', content: 'hi' }] });

    assert.deepEqual(
        posted.filter((message) => message.type === 'delta').map((message) => message.text),
        ['Hel', 'lo']
    );
    const request = webllm.calls.creates[0];
    assert.equal(request.stream, true);
    assert.deepEqual(request.messages, [{ role: 'user', content: 'hi' }]);
    assert.deepEqual(posted.at(-1), {
        type: 'result',
        requestId: 2,
        ok: true,
        value: { finishReason: 'stop', usage: { completion_tokens: 2 } }
    });
});

test('errors cross the boundary as plain data', async () => {
    const posted = [];
    const host = createEngineHost({
        post: (message) => posted.push(message),
        loadLibrary: async () => {
            throw Object.assign(new Error('Cannot find WebGPU in the environment'), { name: 'WebGPUNotFoundError' });
        }
    });
    await host.handle({ type: 'load', requestId: 7 });
    assert.deepEqual(posted.at(-1), {
        type: 'result',
        requestId: 7,
        ok: false,
        error: { name: 'WebGPUNotFoundError', message: 'Cannot find WebGPU in the environment' }
    });

    await host.handle({ type: 'chat', requestId: 8, messages: [] });
    assert.equal(posted.at(-1).ok, false);
    assert.match(posted.at(-1).error.message, /not loaded/);
});

test('the client round-trips load, chat, interrupt and release through the page transport', async () => {
    const webllm = fakeWebLLM({ chunks: ['x', 'y', 'z'] });
    const transport = createPageTransport(({ post }) =>
        createEngineHost({ post, loadLibrary: async () => webllm.module })
    );
    const client = new WebLLMEngineClient(transport);
    assert.equal(client.kind, 'page');

    const progress = [];
    await client.load((report) => progress.push(report.progress));
    assert.deepEqual(progress, [0.5]);

    let text = '';
    const result = await client.chat([{ role: 'user', content: 'go' }], (delta) => {
        text += delta;
    });
    assert.equal(text, 'xyz');
    assert.equal(result.finishReason, 'stop');

    client.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(webllm.calls.interrupts, 1);

    client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(webllm.calls.unloads, 1, 'releasing the page engine unloads it from the GPU');
    await assert.rejects(
        client.chat([], () => {}),
        { name: 'AbortError' }
    );
});

test('releasing the client rejects whatever was still waiting', async () => {
    const sent = [];
    const client = new WebLLMEngineClient({
        kind: 'worker',
        post: (message) => sent.push(message),
        onMessage: () => {},
        onCrash: () => {},
        terminate: () => sent.push({ type: 'terminated' })
    });
    const loading = client.load(() => {});
    client.dispose();
    await assert.rejects(loading, { name: 'AbortError' });
    assert.equal(sent.at(-1).type, 'terminated');
});

test('a worker that cannot see WebGPU is dropped for the in-page engine', async () => {
    class FakeWorker extends EventTarget {
        constructor(webgpu) {
            super();
            this.terminated = false;
            setTimeout(
                () => this.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'hello', webgpu } })),
                0
            );
        }
        postMessage() {}
        terminate() {
            this.terminated = true;
        }
    }

    const blind = new FakeWorker(false);
    assert.equal(await createWorkerTransport(() => blind), null);
    assert.equal(blind.terminated, true);

    const able = await createWorkerTransport(() => new FakeWorker(true));
    assert.equal(able.kind, 'worker');

    assert.equal(
        await createWorkerTransport(() => {
            throw new Error('no module workers');
        }),
        null
    );

    const fallback = await createEngineClient({
        workerTransport: async () => null,
        pageTransport: () =>
            createPageTransport(({ post }) => createEngineHost({ post, loadLibrary: async () => fakeWebLLM().module }))
    });
    assert.equal(fallback.kind, 'page');
});

test('the library is imported only after its bytes match the pinned hash', async () => {
    const bytes = Buffer.from('export default 1;');
    const integrity = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
    assert.equal(await matchesIntegrity(bytes, integrity), true);
    assert.equal(await matchesIntegrity(bytes, 'sha384-AAAA'), false);

    const previous = { fetch: globalThis.fetch, caches: globalThis.caches };
    globalThis.caches = undefined;
    try {
        let imported = 0;
        globalThis.fetch = async () => new Response(bytes);
        const module = await loadWebLLMLibrary({
            integrity,
            importer: async (url) => {
                imported += 1;
                assert.match(url, /^blob:/);
                return { ok: true };
            }
        });
        assert.deepEqual(module, { ok: true });
        assert.equal(imported, 1);

        globalThis.fetch = async () => new Response('tampered');
        await assert.rejects(
            loadWebLLMLibrary({ integrity, importer: async () => assert.fail('must not import') }),
            /integrity/
        );

        globalThis.fetch = async () => new Response('down', { status: 503 });
        await assert.rejects(loadWebLLMLibrary({ integrity }), /status 503/);
    } finally {
        globalThis.fetch = previous.fetch;
        globalThis.caches = previous.caches;
    }
});
