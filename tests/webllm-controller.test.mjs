/**
 * The local AI chat's state machine, driven with doubles.
 *
 * What these pin: nothing happens until the tab is opened; nothing downloads
 * until Install; one install at a time however often it is asked for; a
 * cached model loads by itself in a later session; failures say what to do
 * and can be retried; streaming reaches the message as it arrives; and locking
 * the wallet releases the engine and the conversation while keeping the
 * downloaded model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WebLLMController, WEBLLM_INSTALL_LOCK } from '../src/webllm/WebLLMController.js';
import { WEBLLM_SYSTEM_PROMPT } from '../src/webllm/webllmConfig.js';
import { INFORMATIVE_SYSTEM_PROMPT } from '../src/webllm/webllmThinking.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** An engine double that records what it was asked and lets a test control timing. */
function fakeEngine({ loadGate = null, chunks = ['Hello', ' there', '!'], loadError = null } = {}) {
    const engine = {
        kind: 'worker',
        loads: 0,
        chats: [],
        interrupted: 0,
        disposed: 0,
        /** @type {Function|null} */
        onProgress: null,
        async load(onProgress) {
            engine.loads += 1;
            engine.onProgress = onProgress;
            onProgress({ progress: 0, text: 'Start to fetch params' });
            onProgress({
                progress: 0.5,
                text: 'Fetching param cache[11/22]: 356MB fetched. 50% completed, 4 secs elapsed.'
            });
            if (loadGate) await loadGate;
            if (loadError) throw loadError;
            onProgress({ progress: 1, text: 'Finish loading on WebGPU - test' });
            return { alreadyLoaded: false };
        },
        async chat(messages, onDelta) {
            engine.chats.push(messages);
            for (const chunk of chunks) {
                await flush();
                onDelta(chunk);
            }
            return { finishReason: 'stop' };
        },
        interrupt() {
            engine.interrupted += 1;
        },
        dispose() {
            engine.disposed += 1;
        }
    };
    return engine;
}

function harness({
    gpu = { supported: true, reason: null, vendor: 'test', description: 'gpu' },
    cacheState = 'absent',
    engines = [fakeEngine()],
    storage = null,
    locks = null,
    legacyBytes = 0
} = {}) {
    const calls = { detect: 0, status: 0, prepare: 0, clear: 0, clearLegacy: 0, create: 0 };
    const changes = [];
    let model = { state: cacheState, bytesCached: cacheState === 'partial' ? 300 : 0, bytesTotal: 1000 };
    let legacy = legacyBytes ? [{ state: 'installed', bytesCached: legacyBytes }] : [];
    const controller = new WebLLMController({
        detectWebGPU: async () => {
            calls.detect += 1;
            return gpu;
        },
        swClient: {
            status: async () => {
                calls.status += 1;
                return { model, legacy };
            },
            prepareLibrary: async () => {
                calls.prepare += 1;
                return { cached: true };
            },
            clearModel: async () => {
                calls.clear += 1;
                model = { state: 'absent', bytesCached: 0, bytesTotal: 0 };
                return { removed: 3 };
            },
            clearLegacyModels: async () => {
                calls.clearLegacy += 1;
                legacy = [{ state: 'absent', bytesCached: 0 }];
                return [{ removed: 4 }];
            }
        },
        createEngine: async () => {
            calls.create += 1;
            return engines.shift() || fakeEngine();
        },
        storage,
        locks,
        onChange: (state, change) => changes.push({ status: state.status, type: change.type })
    });
    return {
        controller,
        calls,
        changes,
        setModel: (next) => {
            model = next;
        }
    };
}

test('nothing is detected, registered or downloaded until the tab is opened', async () => {
    const { controller, calls } = harness();
    assert.equal(controller.state.status, 'locked');

    controller.setAllowed(true);
    await flush();
    assert.equal(controller.state.status, 'idle');
    assert.deepEqual(calls, { detect: 0, status: 0, prepare: 0, clear: 0, clearLegacy: 0, create: 0 });

    await controller.activate();
    assert.equal(controller.state.status, 'not-installed');
    assert.equal(calls.detect, 1);
    assert.equal(calls.status, 1);
    // Opening the tab never starts the download.
    assert.equal(calls.prepare, 0);
    assert.equal(calls.create, 0);
});

test('activate does nothing while the wallet is locked', async () => {
    const { controller, calls } = harness();
    await controller.activate();
    await controller.install();
    assert.equal(controller.state.status, 'locked');
    assert.equal(calls.detect, 0);
    assert.equal(calls.create, 0);
});

test('a device without WebGPU is told so and offered no install', async () => {
    const { controller, calls } = harness({
        gpu: { supported: false, reason: 'WebGPU is not available in this browser.' }
    });
    controller.setAllowed(true);
    await controller.activate();
    assert.equal(controller.state.status, 'unsupported');
    assert.equal(controller.state.error.kind, 'unsupported');
    assert.match(controller.state.error.message, /WebGPU is not available/);

    await controller.install();
    assert.equal(calls.create, 0);
    assert.equal(controller.state.status, 'unsupported');
});

test('Install downloads with real progress and ends in the chat', async () => {
    const gate = deferred();
    const engine = fakeEngine({ loadGate: gate.promise });
    const { controller, calls } = harness({ engines: [engine] });
    controller.setAllowed(true);
    await controller.activate();

    const install = controller.install();
    await flush();
    assert.equal(controller.state.status, 'installing');
    assert.equal(controller.state.fromCache, false);
    assert.equal(controller.state.progress.phase, 'download');
    assert.equal(controller.state.progress.percent, 50);
    assert.equal(calls.prepare, 1, 'the library is handed to the WebLLM service worker first');

    gate.resolve();
    await install;
    assert.equal(controller.state.status, 'ready');
    assert.equal(controller.state.engineKind, 'worker');
    assert.equal(controller.state.cache.state, 'installed');
});

test('pressing Install again while installing joins the same download', async () => {
    const gate = deferred();
    const engine = fakeEngine({ loadGate: gate.promise });
    const { controller, calls } = harness({ engines: [engine] });
    controller.setAllowed(true);
    await controller.activate();

    const first = controller.install();
    const second = controller.install();
    const third = controller.install();
    assert.equal(first, second);
    assert.equal(second, third);
    gate.resolve();
    await first;

    assert.equal(calls.create, 1);
    assert.equal(engine.loads, 1);
    await controller.install();
    assert.equal(calls.create, 1, 'a ready model is not loaded again');
});

test('a later session loads the cached model by itself, without the install screen', async () => {
    const engine = fakeEngine();
    const { controller, calls } = harness({ cacheState: 'installed', engines: [engine] });
    controller.setAllowed(true);
    await controller.activate();

    assert.equal(controller.state.status, 'ready');
    assert.equal(controller.state.fromCache, true);
    assert.equal(calls.create, 1);
});

test('a network failure is retryable, and the retry says how much survived', async () => {
    const failing = fakeEngine({ loadError: Object.assign(new Error('Failed to fetch'), { name: 'TypeError' }) });
    const working = fakeEngine();
    const { controller, calls, setModel } = harness({ engines: [failing, working] });
    controller.setAllowed(true);
    await controller.activate();

    setModel({ state: 'partial', bytesCached: 430, bytesTotal: 1000 });
    await controller.install();
    assert.equal(controller.state.status, 'error');
    assert.equal(controller.state.error.kind, 'network');
    assert.equal(controller.state.error.retryable, true);
    assert.equal(controller.state.cache.state, 'partial');
    assert.equal(controller.state.cache.percent, 43);
    assert.equal(failing.disposed, 1, 'a failed engine releases its GPU resources');

    await controller.retry();
    assert.equal(controller.state.status, 'ready');
    assert.equal(calls.create, 2);
});

test('a download the browser has no room for is refused before it starts', async () => {
    const { controller, calls } = harness({
        storage: {
            estimate: async () => ({ usage: 900 * 1024 * 1024, quota: 1000 * 1024 * 1024 }),
            persist: async () => true
        }
    });
    controller.setAllowed(true);
    await controller.activate();
    await controller.install();

    assert.equal(controller.state.status, 'error');
    assert.equal(controller.state.error.kind, 'storage');
    assert.equal(calls.create, 0);
});

test('persistent storage is requested so the model survives storage pressure', async () => {
    let persisted = 0;
    const { controller } = harness({
        storage: {
            estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }),
            persist: async () => {
                persisted += 1;
                return true;
            }
        }
    });
    controller.setAllowed(true);
    await controller.activate();
    await controller.install();
    assert.equal(persisted, 1);
    assert.equal(controller.state.status, 'ready');
});

test('a second tab waits for the install lock, then loads what the first one cached', async () => {
    const requests = [];
    const held = deferred();
    const locks = {
        async request(name, options, callback) {
            requests.push({ name, options });
            if (options.ifAvailable) return callback(null);
            await held.promise;
            return callback({ name });
        }
    };
    const { controller } = harness({ locks });
    controller.setAllowed(true);
    await controller.activate();

    const install = controller.install();
    await flush();
    await flush();
    assert.equal(controller.state.waitingForOtherTab, true);
    assert.equal(requests[0].name, WEBLLM_INSTALL_LOCK);

    held.resolve();
    await install;
    assert.equal(controller.state.status, 'ready');
    assert.equal(controller.state.waitingForOtherTab, false);
});

test('replies stream into the assistant bubble as they arrive', async () => {
    const engine = fakeEngine({ chunks: ['Local', ' AI', ' here.'] });
    const { controller, changes } = harness({ engines: [engine] });
    controller.setAllowed(true);
    await controller.activate();
    await controller.install();

    const sending = controller.send('  Hi Llama  ');
    await flush();
    assert.equal(controller.state.generating, true);
    // A second message while one is generating is ignored.
    assert.equal(await controller.send('ignored'), false);
    await sending;

    const [user, reply] = controller.state.messages;
    assert.equal(user.role, 'user');
    assert.equal(user.content, 'Hi Llama');
    assert.equal(reply.role, 'assistant');
    assert.equal(reply.content, 'Local AI here.');
    assert.equal(reply.pending, false);
    assert.equal(controller.state.generating, false);
    assert.equal(changes.filter((change) => change.type === 'delta').length, 3);

    // The model is given the developer system prompt and the user's turn.
    const sent = engine.chats[0];
    assert.deepEqual(sent, [
        { role: 'system', content: INFORMATIVE_SYSTEM_PROMPT },
        { role: 'user', content: 'Hi Llama' }
    ]);

    // The next turn carries the conversation so far.
    await controller.send('And again?');
    assert.deepEqual(
        engine.chats[1].map((message) => message.role),
        ['system', 'user', 'assistant', 'user']
    );
});

test('Stop interrupts generation and New chat clears the conversation', async () => {
    const engine = fakeEngine();
    const { controller } = harness({ engines: [engine] });
    controller.setAllowed(true);
    await controller.activate();
    await controller.install();

    const sending = controller.send('Long answer please');
    await flush();
    controller.stop();
    assert.equal(engine.interrupted, 1);
    await sending;

    controller.newChat();
    assert.equal(controller.state.messages.length, 0);
});

test('a generation error stays in its bubble and is not sent back to the model', async () => {
    const engine = fakeEngine();
    engine.chat = async () => {
        throw Object.assign(new Error('Prompt tokens exceed context window size'), {
            name: 'ContextWindowSizeExceededError'
        });
    };
    const { controller } = harness({ engines: [engine] });
    controller.setAllowed(true);
    await controller.activate();
    await controller.install();

    await controller.send('Hello');
    const reply = controller.state.messages[1];
    assert.match(reply.error, /Start a new chat/);
    assert.equal(controller.state.status, 'ready');
});

test('locking the wallet releases the engine and the conversation, and keeps the model files', async () => {
    const engine = fakeEngine();
    const { controller, calls } = harness({ engines: [engine] });
    controller.setAllowed(true);
    await controller.activate();
    await controller.install();
    await controller.send('Remember this');
    assert.equal(controller.state.messages.length, 2);

    controller.setAllowed(false);
    assert.equal(controller.state.status, 'locked');
    assert.equal(controller.state.messages.length, 0);
    assert.equal(engine.disposed, 1, 'the worker is terminated, which frees the GPU');
    assert.equal(controller.engine, null);
    assert.equal(calls.clear, 0, 'the downloaded model stays cached');
    assert.equal(await controller.send('after lock'), false);

    // The next session starts from the cache, not from a download.
    controller.setAllowed(true);
    assert.equal(controller.state.status, 'idle');
});

test('a lock during a download discards everything the old session would have produced', async () => {
    const gate = deferred();
    const engine = fakeEngine({ loadGate: gate.promise });
    const { controller } = harness({ engines: [engine] });
    controller.setAllowed(true);
    await controller.activate();

    const install = controller.install();
    await flush();
    assert.equal(controller.state.status, 'installing');
    controller.setAllowed(false);
    assert.equal(engine.disposed, 1);

    // Late progress and a late success from the released engine change nothing.
    engine.onProgress?.({ progress: 0.9, text: 'Fetching param cache[20/22]: 640MB fetched. 90% completed' });
    gate.resolve();
    await install;
    assert.equal(controller.state.status, 'locked');
    assert.equal(controller.state.progress, null);
});

test('a lock mid-reply drops the reply instead of finishing it', async () => {
    const engine = fakeEngine({ chunks: ['one', ' two', ' three'] });
    const { controller } = harness({ engines: [engine] });
    controller.setAllowed(true);
    await controller.activate();
    await controller.install();

    const sending = controller.send('Hi');
    await flush();
    controller.setAllowed(false);
    await sending;
    assert.equal(controller.state.messages.length, 0);
    assert.equal(controller.state.generating, false);
});

test('starting a new chat or deleting one never touches the model cache', async () => {
    const engine = fakeEngine();
    const { controller, calls } = harness({ engines: [engine] });
    controller.setAllowed(true);
    await controller.activate();
    await controller.install();
    await controller.send('Hello');

    controller.newChat();
    await controller.send('Again');
    await controller.deleteConversation();
    assert.equal(controller.state.messages.length, 0);
    assert.equal(calls.clear, 0, 'no model files are removed');
    assert.equal(engine.disposed, 0, 'the loaded model stays loaded');
    assert.equal(controller.state.status, 'ready');
    // There is no way left to remove the model from the chat.
    assert.equal(typeof controller.removeModel, 'undefined');
    assert.equal(typeof controller.removeLegacyModels, 'undefined');
});

test('a check left over from before a lock does not disturb the next session', async () => {
    const slow = deferred();
    let detections = 0;
    const { controller } = harness();
    controller.detectWebGPU = async () => {
        detections += 1;
        if (detections === 1) await slow.promise;
        return { supported: true, reason: null, vendor: 'test', description: 'gpu' };
    };
    controller.setAllowed(true);
    const stale = controller.activate();
    controller.setAllowed(false);
    controller.setAllowed(true);
    const current = controller.activate();
    slow.resolve();
    await Promise.all([stale, current]);

    assert.equal(controller.state.status, 'not-installed');
    assert.equal(detections, 2);
    // Opening the tab again does not start a third check.
    await controller.activate();
    assert.equal(detections, 2);
});
