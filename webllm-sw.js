/// <reference path="./types.d.ts" />
// @ts-check
/**
 * WEB25 · WebLLM service worker.
 *
 * A second, separate service worker that exists only for the local AI chat.
 * It is registered lazily — the first time somebody opens the WebLLM tab — on
 * its own scope (`/webllm/`), so it never controls the WEB25 app and never
 * sees one of its requests. `peerweb-sw.js` keeps the `/` scope, its routing
 * and its caches exactly as before.
 *
 * Because the WebLLM tab lives inside the app (outside this scope), nothing
 * here relies on intercepting fetches. There is deliberately no `fetch`
 * listener at all. Everything goes through explicit `postMessage` requests,
 * each answered on the `MessagePort` it brought, so a reply can never reach
 * the app's own service-worker message listener.
 *
 * What it does:
 *   - keeps a verified copy of the pinned WebLLM library in its own cache, so
 *     a later session (or an offline one) does not download it again;
 *   - reports whether the model is in this browser by reading WebLLM's native
 *     caches (`webllm/model`, `webllm/config`, `webllm/wasm`) — the weights are
 *     never copied, so nothing large is stored twice;
 *   - removes the model and its own assets on request;
 *   - reports, and on request removes, an older model build the page no
 *     longer loads (the q4f16 build WEB25 first shipped).
 *
 * What it never does: run inference, touch the GPU, hold wallet state, or
 * delete a cache it does not own. Model files stay cached when the wallet is
 * locked; only an explicit "remove" deletes them.
 */

const SW_VERSION = 'webllm-sw-v1';
const PROTOCOL = 'web25-webllm/1';

/** Kept in step with `WEBLLM_ASSET_CACHE` in src/webllm/webllmConfig.js. */
const ASSET_CACHE = 'web25-webllm-assets-v1';
const ASSET_CACHE_PREFIX = 'web25-webllm-assets-';

/** WebLLM's own Cache Storage buckets. Read here, written only by WebLLM. */
const NATIVE_CACHES = { model: 'webllm/model', config: 'webllm/config', wasm: 'webllm/wasm' };

/** The only origin the library may be fetched from. */
const LIBRARY_PREFIX = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@';

/** The only hosts a model may be described by. */
const MODEL_PREFIX = 'https://huggingface.co/mlc-ai/';
const MODEL_LIB_PREFIX = 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/';

const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

/**
 * Open a cache only if it already exists: `caches.open` creates one, and a
 * status check must not leave empty WebLLM buckets behind.
 * @param {string} name
 */
async function openExisting(name) {
    return (await caches.has(name)) ? caches.open(name) : null;
}

/**
 * @param {ArrayBuffer} bytes
 * @param {string} integrity `sha384-…`
 */
async function matchesIntegrity(bytes, integrity) {
    const [algorithm, expected] = `${integrity}`.split('-', 2);
    const name = /** @type {Record<string, string>} */ ({ sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' })[
        algorithm
    ];
    if (!name || !expected) return false;
    const digest = new Uint8Array(await crypto.subtle.digest(name, bytes));
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    return btoa(binary) === expected;
}

/** @param {string} url */
function assertLibraryUrl(url) {
    if (typeof url !== 'string' || !url.startsWith(LIBRARY_PREFIX)) {
        throw new Error('Only the pinned WebLLM library can be cached.');
    }
}

/** @param {{ modelUrl?: string, modelLibUrl?: string }} model */
function assertModel(model) {
    if (
        typeof model?.modelUrl !== 'string' ||
        !model.modelUrl.startsWith(MODEL_PREFIX) ||
        !model.modelUrl.endsWith('/') ||
        typeof model?.modelLibUrl !== 'string' ||
        !model.modelLibUrl.startsWith(MODEL_LIB_PREFIX)
    ) {
        throw new Error('Unknown model.');
    }
}

/**
 * Whether the model is in WebLLM's caches, and how much of it.
 *
 * Mirrors WebLLM's own `hasModelInCache`: the tensor manifest is read from
 * the model cache and every shard it lists must be there. The chat config,
 * the tokenizer and the compiled model library are checked too, since loading
 * offline needs all of them.
 *
 * @param {{ modelUrl: string, modelLibUrl: string }} model
 */
async function modelStatus({ modelUrl, modelLibUrl }) {
    const status = {
        state: /** @type {'absent'|'partial'|'installed'} */ ('absent'),
        configCached: false,
        tokenizerCached: false,
        wasmCached: false,
        manifestCached: false,
        shardsTotal: 0,
        shardsCached: 0,
        bytesTotal: 0,
        bytesCached: 0
    };

    const configCache = await openExisting(NATIVE_CACHES.config);
    /** @type {any} */
    let chatConfig = null;
    const configResponse = await configCache?.match(new URL('mlc-chat-config.json', modelUrl).href);
    if (configResponse) {
        status.configCached = true;
        try {
            chatConfig = await configResponse.json();
        } catch (_) {
            chatConfig = null;
        }
    }

    const wasmCache = await openExisting(NATIVE_CACHES.wasm);
    status.wasmCached = Boolean(await wasmCache?.match(modelLibUrl));

    const modelCache = await openExisting(NATIVE_CACHES.model);
    if (modelCache) {
        const keys = new Set((await modelCache.keys()).map((request) => request.url));
        const tokenizerFiles = Array.isArray(chatConfig?.tokenizer_files) ? chatConfig.tokenizer_files : [];
        const tokenizerFile = tokenizerFiles.includes('tokenizer.json') ? 'tokenizer.json' : tokenizerFiles[0];
        status.tokenizerCached = Boolean(tokenizerFile) && keys.has(new URL(tokenizerFile, modelUrl).href);

        const manifestResponse = await modelCache.match(new URL('tensor-cache.json', modelUrl).href);
        if (manifestResponse) {
            status.manifestCached = true;
            try {
                const manifest = await manifestResponse.json();
                const records = Array.isArray(manifest?.records) ? manifest.records : [];
                for (const record of records) {
                    const bytes = Number(record?.nbytes) || 0;
                    status.shardsTotal += 1;
                    status.bytesTotal += bytes;
                    if (keys.has(new URL(record.dataPath, modelUrl).href)) {
                        status.shardsCached += 1;
                        status.bytesCached += bytes;
                    }
                }
            } catch (_) {
                status.manifestCached = false;
            }
        }
    }

    const complete =
        status.configCached &&
        status.tokenizerCached &&
        status.wasmCached &&
        status.manifestCached &&
        status.shardsTotal > 0 &&
        status.shardsCached === status.shardsTotal;
    const anything = status.configCached || status.wasmCached || status.manifestCached || status.shardsCached > 0;
    status.state = complete ? 'installed' : anything ? 'partial' : 'absent';
    return status;
}

/** @param {string} url */
async function libraryCached(url) {
    const cache = await openExisting(ASSET_CACHE);
    return Boolean(await cache?.match(url));
}

async function storageEstimate() {
    try {
        const estimate = await navigator.storage?.estimate?.();
        if (!estimate) return null;
        return { usage: Number(estimate.usage) || 0, quota: Number(estimate.quota) || 0 };
    } catch (_) {
        return null;
    }
}

/**
 * Make sure the verified library is in the asset cache.
 * @param {{ url: string, integrity: string }} library
 */
async function prepareLibrary({ url, integrity }) {
    assertLibraryUrl(url);
    const cache = await caches.open(ASSET_CACHE);
    const existing = await cache.match(url);
    if (existing && (await matchesIntegrity(await existing.clone().arrayBuffer(), integrity))) {
        return { cached: true, downloaded: false };
    }

    const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-cache' });
    if (!response.ok) throw new Error(`WebLLM library download failed (status ${response.status})`);
    const bytes = await response.arrayBuffer();
    if (!(await matchesIntegrity(bytes, integrity))) {
        throw new Error('The WebLLM library did not match its pinned integrity hash.');
    }
    await cache.put(
        url,
        new Response(bytes, {
            headers: { 'Content-Type': 'text/javascript', 'X-Web25-Integrity': integrity }
        })
    );
    return { cached: true, downloaded: true };
}

/**
 * Delete one model from WebLLM's caches, and this worker's own assets.
 *
 * Entry by entry, under the model's own URLs, so nothing that belongs to a
 * different model (or to anything else) is touched; a bucket left empty is
 * removed.
 *
 * @param {{ modelUrl: string, modelLibUrl: string, includeLibrary?: boolean }} request
 */
async function clearModel({ modelUrl, modelLibUrl, includeLibrary = true }) {
    let removed = 0;
    for (const name of [NATIVE_CACHES.model, NATIVE_CACHES.config]) {
        const cache = await openExisting(name);
        if (!cache) continue;
        const keys = await cache.keys();
        for (const request of keys) {
            if (request.url.startsWith(modelUrl)) {
                if (await cache.delete(request)) removed += 1;
            }
        }
        if ((await cache.keys()).length === 0) await caches.delete(name);
    }

    const wasmCache = await openExisting(NATIVE_CACHES.wasm);
    if (wasmCache) {
        if (await wasmCache.delete(modelLibUrl)) removed += 1;
        if ((await wasmCache.keys()).length === 0) await caches.delete(NATIVE_CACHES.wasm);
    }

    if (includeLibrary && (await caches.delete(ASSET_CACHE))) removed += 1;
    return { removed };
}

/** Old versions of this worker's own asset cache. Nothing else is ever pruned. */
async function cleanupOldAssetCaches() {
    const names = await caches.keys();
    const stale = names.filter((name) => name.startsWith(ASSET_CACHE_PREFIX) && name !== ASSET_CACHE);
    await Promise.all(stale.map((name) => caches.delete(name)));
    return stale.length;
}

/** @param {any} data */
async function handleRequest(data) {
    switch (data.type) {
        case 'PING':
            return { version: SW_VERSION };
        case 'STATUS': {
            assertModel(data.model);
            if (data.library) assertLibraryUrl(data.library.url);
            // Builds the page no longer loads, reported so the user can decide
            // what to do with them. Reading them changes nothing.
            const legacyModels = Array.isArray(data.legacy) ? data.legacy : [];
            legacyModels.forEach(assertModel);
            const [model, library, storage, legacy] = await Promise.all([
                modelStatus(data.model),
                data.library ? libraryCached(data.library.url) : Promise.resolve(false),
                storageEstimate(),
                Promise.all(
                    legacyModels.map(async (entry) => ({ modelUrl: entry.modelUrl, ...(await modelStatus(entry)) }))
                )
            ]);
            return { version: SW_VERSION, model, libraryCached: library, storage, legacy };
        }
        case 'PREPARE_LIBRARY':
            return prepareLibrary(data.library);
        case 'CLEAR_MODEL':
            assertModel(data.model);
            return clearModel({ ...data.model, includeLibrary: data.includeLibrary !== false });
        default:
            throw new Error(`Unknown WebLLM service worker request: ${data.type}`);
    }
}

sw.addEventListener('message', (event) => {
    const data = event.data;
    const port = event.ports?.[0];
    // Only requests on this protocol, and only ones that brought a port to
    // answer on. Anything else is not for this worker.
    if (!data || data.protocol !== PROTOCOL || !port) return;

    const work = handleRequest(data).then(
        (result) => port.postMessage({ ok: true, result }),
        (error) =>
            port.postMessage({
                ok: false,
                error: { name: `${error?.name || 'Error'}`, message: `${error?.message || error}` }
            })
    );
    event.waitUntil?.(work);
});

sw.addEventListener('install', (event) => {
    event.waitUntil(sw.skipWaiting());
});

sw.addEventListener('activate', (event) => {
    // No `clients.claim()`: there are no pages in this scope to claim, and the
    // app's pages belong to peerweb-sw.js.
    event.waitUntil(cleanupOldAssetCaches());
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SW_VERSION,
        PROTOCOL,
        ASSET_CACHE,
        NATIVE_CACHES,
        handleRequest,
        modelStatus,
        prepareLibrary,
        clearModel,
        cleanupOldAssetCaches,
        matchesIntegrity
    };
}
