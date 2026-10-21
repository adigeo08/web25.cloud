/**
 * The WebLLM service worker, and how it sits next to peerweb-sw.js.
 *
 * It answers explicit requests on a MessagePort and does nothing else: no
 * fetch interception, no page control, no cache it does not own. These run
 * the real worker script against an in-memory Cache Storage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
    WEBLLM_ASSET_CACHE,
    WEBLLM_LIBRARY_URL,
    WEBLLM_MODEL_LIB_URL,
    WEBLLM_MODEL_URL,
    WEBLLM_NATIVE_CACHES,
    WEBLLM_SW_SCOPE,
    WEBLLM_SW_URL
} from '../src/webllm/webllmConfig.js';
import { createWebLLMServiceWorkerClient, WEBLLM_SW_PROTOCOL } from '../src/webllm/WebLLMServiceWorkerClient.js';

const require = createRequire(import.meta.url);

/** Cache Storage, in memory, with the surface the worker uses. */
function fakeCacheStorage() {
    const stores = new Map();
    const makeCache = (entries) => ({
        entries,
        async match(request) {
            const url = typeof request === 'string' ? request : request.url;
            const body = entries.get(url);
            return body === undefined ? undefined : new Response(body);
        },
        async keys() {
            return [...entries.keys()].map((url) => ({ url }));
        },
        async put(request, response) {
            const url = typeof request === 'string' ? request : request.url;
            entries.set(url, new Uint8Array(await response.arrayBuffer()));
        },
        async delete(request) {
            const url = typeof request === 'string' ? request : request.url;
            return entries.delete(url);
        }
    });
    return {
        stores,
        async has(name) {
            return stores.has(name);
        },
        async open(name) {
            if (!stores.has(name)) stores.set(name, makeCache(new Map()));
            return stores.get(name);
        },
        async keys() {
            return [...stores.keys()];
        },
        async delete(name) {
            return stores.delete(name);
        },
        /** Seed a cache directly, the way WebLLM would have filled it. */
        seed(name, entries) {
            const cache = makeCache(new Map(Object.entries(entries)));
            stores.set(name, cache);
            return cache;
        }
    };
}

const listeners = new Map();
global.self = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: { scope: 'http://localhost/webllm/' }
};
const sw = require('../webllm-sw.js');

let storage;
test.beforeEach(() => {
    storage = fakeCacheStorage();
    global.caches = storage;
});

const MODEL = { modelUrl: WEBLLM_MODEL_URL, modelLibUrl: WEBLLM_MODEL_LIB_URL };
const at = (file) => new URL(file, WEBLLM_MODEL_URL).href;
const MANIFEST = JSON.stringify({
    records: [
        { dataPath: 'params_shard_0.bin', nbytes: 600 },
        { dataPath: 'params_shard_1.bin', nbytes: 400 }
    ]
});
const CHAT_CONFIG = JSON.stringify({ tokenizer_files: ['tokenizer.json', 'tokenizer_config.json'] });

function seedFullModel() {
    storage.seed(WEBLLM_NATIVE_CACHES.config, { [at('mlc-chat-config.json')]: CHAT_CONFIG });
    storage.seed(WEBLLM_NATIVE_CACHES.wasm, { [WEBLLM_MODEL_LIB_URL]: 'wasm' });
    storage.seed(WEBLLM_NATIVE_CACHES.model, {
        [at('tensor-cache.json')]: MANIFEST,
        [at('tokenizer.json')]: '{}',
        [at('params_shard_0.bin')]: 'a',
        [at('params_shard_1.bin')]: 'b'
    });
}

test('the worker and the page agree on the cache names', () => {
    assert.equal(sw.ASSET_CACHE, WEBLLM_ASSET_CACHE);
    assert.deepEqual({ ...sw.NATIVE_CACHES }, { ...WEBLLM_NATIVE_CACHES });
    assert.equal(sw.PROTOCOL, WEBLLM_SW_PROTOCOL);
});

test('it intercepts no requests at all: there is no fetch listener', () => {
    assert.equal(listeners.has('fetch'), false);
    assert.ok(listeners.has('message'));
    assert.ok(listeners.has('install'));
    assert.ok(listeners.has('activate'));
});

test('an empty browser reports the model absent, without creating any cache', async () => {
    const status = await sw.modelStatus(MODEL);
    assert.equal(status.state, 'absent');
    assert.deepEqual(await storage.keys(), []);
});

test('a complete model is reported installed from WebLLM’s own caches', async () => {
    seedFullModel();
    const status = await sw.modelStatus(MODEL);
    assert.equal(status.state, 'installed');
    assert.equal(status.shardsTotal, 2);
    assert.equal(status.shardsCached, 2);
    assert.equal(status.bytesCached, 1000);
    assert.equal(status.tokenizerCached, true);
});

test('an interrupted download is partial, with how much is already here', async () => {
    seedFullModel();
    await storage.stores.get(WEBLLM_NATIVE_CACHES.model).delete(at('params_shard_1.bin'));
    const status = await sw.modelStatus(MODEL);
    assert.equal(status.state, 'partial');
    assert.equal(status.bytesCached, 600);
    assert.equal(status.bytesTotal, 1000);
});

test('the library is cached only when it matches its pinned hash', async () => {
    const bytes = Buffer.from('export const ok = true;');
    const integrity = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
    let fetches = 0;
    global.fetch = async () => {
        fetches += 1;
        return new Response(bytes);
    };

    const first = await sw.prepareLibrary({ url: WEBLLM_LIBRARY_URL, integrity });
    assert.deepEqual(first, { cached: true, downloaded: true });
    const second = await sw.prepareLibrary({ url: WEBLLM_LIBRARY_URL, integrity });
    assert.deepEqual(second, { cached: true, downloaded: false });
    assert.equal(fetches, 1, 'a cached, verified copy is not downloaded again');

    await storage.delete(WEBLLM_ASSET_CACHE);
    await assert.rejects(sw.prepareLibrary({ url: WEBLLM_LIBRARY_URL, integrity: 'sha384-AAAA' }), /integrity/);
    assert.equal((await storage.open(WEBLLM_ASSET_CACHE)).entries.size, 0);

    await assert.rejects(sw.prepareLibrary({ url: 'https://example.com/evil.js', integrity }), /pinned WebLLM library/);
});

test('removing the model deletes only that model, and never another cache', async () => {
    seedFullModel();
    storage.seed(WEBLLM_NATIVE_CACHES.model, {
        ...Object.fromEntries(storage.stores.get(WEBLLM_NATIVE_CACHES.model).entries),
        'https://huggingface.co/mlc-ai/Other-Model-MLC/resolve/main/tensor-cache.json': '{}'
    });
    storage.seed(WEBLLM_ASSET_CACHE, { [WEBLLM_LIBRARY_URL]: 'lib' });
    storage.seed('peerweb-cache-v1.0.0', { 'http://localhost/peerweb-site/x/index.html': 'site' });

    const result = await sw.clearModel({ ...MODEL, includeLibrary: true });
    assert.ok(result.removed >= 6);

    const names = await storage.keys();
    assert.ok(names.includes('peerweb-cache-v1.0.0'), 'the PeerWeb cache is untouched');
    assert.ok(!names.includes(WEBLLM_ASSET_CACHE));
    assert.ok(!names.includes(WEBLLM_NATIVE_CACHES.config), 'an emptied bucket is removed');
    assert.ok(!names.includes(WEBLLM_NATIVE_CACHES.wasm));
    // Another model in the same bucket survives.
    const left = [...storage.stores.get(WEBLLM_NATIVE_CACHES.model).entries.keys()];
    assert.deepEqual(left, ['https://huggingface.co/mlc-ai/Other-Model-MLC/resolve/main/tensor-cache.json']);
});

test('activation prunes old copies of its own asset cache and nothing else', async () => {
    storage.seed('web25-webllm-assets-v0', {});
    storage.seed(WEBLLM_ASSET_CACHE, {});
    storage.seed('peerweb-cache-v0.9.0', {});
    storage.seed(WEBLLM_NATIVE_CACHES.model, {});
    assert.equal(await sw.cleanupOldAssetCaches(), 1);
    const names = await storage.keys();
    assert.deepEqual(names.sort(), [WEBLLM_ASSET_CACHE, 'peerweb-cache-v0.9.0', WEBLLM_NATIVE_CACHES.model].sort());
});

test('messages are answered only on this protocol, and only on the port they brought', async () => {
    const handler = listeners.get('message');
    const pending = [];
    /** Each request gets its own port, and its reply is read from that port. */
    const send = (data, withPort = true) => {
        const replies = [];
        const port = { postMessage: (message) => replies.push(message) };
        handler({ data, ports: withPort ? [port] : [], waitUntil: (promise) => pending.push(promise) });
        return replies;
    };

    send({ type: 'PING' });
    send({ protocol: WEBLLM_SW_PROTOCOL, type: 'PING' }, false);
    send({ type: 'SITE_LOADING', hash: 'abc' });
    assert.equal(pending.length, 0, 'messages meant for peerweb-sw.js are ignored');

    const ping = send({ protocol: WEBLLM_SW_PROTOCOL, type: 'PING' });
    const status = send({
        protocol: WEBLLM_SW_PROTOCOL,
        type: 'STATUS',
        model: MODEL,
        library: { url: WEBLLM_LIBRARY_URL }
    });
    const refused = send({
        protocol: WEBLLM_SW_PROTOCOL,
        type: 'STATUS',
        model: { modelUrl: 'https://evil.test/', modelLibUrl: 'x' }
    });
    await Promise.all(pending);

    assert.equal(ping[0].ok, true);
    assert.equal(ping[0].result.version, sw.SW_VERSION);
    assert.equal(status[0].ok, true);
    assert.equal(status[0].result.model.state, 'absent');
    assert.equal(status[0].result.libraryCached, false);
    assert.equal(refused[0].ok, false);
    assert.match(refused[0].error.message, /Unknown model/);
});

test('the page registers it lazily on its own scope and talks to it through a port', async () => {
    const registered = [];
    const posted = [];
    const worker = {
        postMessage(message, transfer) {
            posted.push({ message, transfer });
            transfer[0].postMessage({ ok: true, result: { version: 'test' } });
        }
    };
    const container = {
        controller: {
            postMessage() {
                throw new Error('the app’s own controller must never be used');
            }
        },
        register: async (url, options) => {
            registered.push({ url, options });
            return { active: worker };
        }
    };

    const client = createWebLLMServiceWorkerClient({ container });
    assert.equal(registered.length, 0, 'creating the client registers nothing');

    const answer = await client.ping();
    await client.status();
    assert.deepEqual(answer, { version: 'test' });
    assert.equal(registered.length, 1, 'registered once');
    assert.equal(registered[0].url, WEBLLM_SW_URL);
    assert.deepEqual(registered[0].options, { scope: WEBLLM_SW_SCOPE });
    assert.equal(posted[0].message.protocol, WEBLLM_SW_PROTOCOL);
    assert.ok(posted[0].transfer[0], 'every request carries its reply port');
});

test('without service workers the client degrades to null', async () => {
    const client = createWebLLMServiceWorkerClient({ container: null });
    assert.equal(await client.status(), null);
    const failing = createWebLLMServiceWorkerClient({
        container: {
            register: async () => {
                throw new Error('SecurityError');
            }
        }
    });
    assert.equal(await failing.status(), null);
});

test('peerweb-sw.js keeps the root scope and never unregisters the WebLLM worker', () => {
    const bridge = readFileSync(new URL('../src/core/serviceworker/ServiceWorkerBridge.js', import.meta.url), 'utf8');
    // The app worker still registers on `/`, and only replaces registrations of itself.
    assert.match(bridge, /register\('\.\/peerweb-sw\.js', \{\s*scope: '\/'\s*\}\)/);
    assert.match(bridge, /scriptURL\.includes\('peerweb-sw\.js'\)/);
    assert.equal('http://localhost/webllm-sw.js'.includes('peerweb-sw.js'), false);

    // Distinct scopes: the WebLLM worker controls no WEB25 page.
    assert.notEqual(new URL(WEBLLM_SW_SCOPE, 'http://localhost/').pathname, '/');
    assert.equal(new URL(WEBLLM_SW_SCOPE, 'http://localhost/').pathname, '/webllm/');

    // And peerweb-sw.js prunes only its own caches.
    const peerweb = readFileSync(new URL('../peerweb-sw.js', import.meta.url), 'utf8');
    assert.match(peerweb, /name\.startsWith\('peerweb-cache-'\)/);
    assert.doesNotMatch(peerweb, /webllm/i);
});
