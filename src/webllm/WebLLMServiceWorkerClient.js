// @ts-check
/**
 * The page's side of the WebLLM service worker (`webllm-sw.js`).
 *
 * Registered lazily, on its own `/webllm/` scope, the first time the WebLLM tab
 * asks for it — never during application start-up. The app's pages stay
 * controlled by `peerweb-sw.js`, so this worker is addressed directly through
 * its registration and every request carries a `MessageChannel` port for the
 * answer: nothing is posted to `navigator.serviceWorker.controller`, and no
 * reply arrives on the app's own service-worker message listener.
 *
 * Every method degrades to `null` when service workers are unavailable (a
 * private window, an old browser, a failed registration). The chat works
 * without this worker; it only loses the library cache and the status check.
 */

import {
    WEBLLM_LIBRARY_INTEGRITY,
    WEBLLM_LIBRARY_URL,
    WEBLLM_MODEL_LIB_URL,
    WEBLLM_MODEL_URL,
    WEBLLM_SW_SCOPE,
    WEBLLM_SW_URL
} from './webllmConfig.js';

export const WEBLLM_SW_PROTOCOL = 'web25-webllm/1';

const ACTIVATION_TIMEOUT_MS = 10000;

/**
 * @param {ServiceWorkerRegistration} registration
 * @returns {Promise<ServiceWorker|null>}
 */
function activeWorker(registration, timeoutMs = ACTIVATION_TIMEOUT_MS) {
    if (registration.active) return Promise.resolve(registration.active);
    const pending = registration.installing || registration.waiting;
    if (!pending) return Promise.resolve(null);
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(registration.active || null), timeoutMs);
        pending.addEventListener('statechange', () => {
            if (pending.state === 'activated' || pending.state === 'redundant') {
                clearTimeout(timer);
                resolve(registration.active || null);
            }
        });
    });
}

/**
 * @param {{ container?: ServiceWorkerContainer|null, scriptUrl?: string, scope?: string,
 *           timeoutMs?: number, log?: (message: string) => void }} [options]
 */
export function createWebLLMServiceWorkerClient({
    container = typeof navigator !== 'undefined' ? navigator.serviceWorker || null : null,
    scriptUrl = WEBLLM_SW_URL,
    scope = WEBLLM_SW_SCOPE,
    timeoutMs = 15000,
    log = () => {}
} = {}) {
    /** @type {Promise<ServiceWorker|null>|null} */
    let ready = null;

    /** Register once; a failure is retried on the next call. */
    function register() {
        if (!container) return Promise.resolve(null);
        if (!ready) {
            ready = container
                .register(scriptUrl, { scope })
                .then((registration) => activeWorker(registration))
                .catch((error) => {
                    log(`WebLLM service worker unavailable: ${error?.message || error}`);
                    ready = null;
                    return null;
                });
        }
        return ready;
    }

    /**
     * One request, one port, one answer.
     * @param {string} type
     * @param {Record<string, any>} [payload]
     * @returns {Promise<any|null>} the result, or null when the worker is unavailable
     */
    async function request(type, payload = {}) {
        const worker = await register();
        if (!worker) return null;
        const channel = new MessageChannel();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                channel.port1.close();
                resolve(null);
            }, timeoutMs);
            channel.port1.onmessage = (event) => {
                clearTimeout(timer);
                channel.port1.close();
                const data = event.data || {};
                if (data.ok) resolve(data.result);
                else {
                    reject(
                        Object.assign(new Error(data.error?.message || 'WebLLM service worker error'), {
                            name: data.error?.name || 'Error'
                        })
                    );
                }
            };
            worker.postMessage({ protocol: WEBLLM_SW_PROTOCOL, type, ...payload }, [channel.port2]);
        });
    }

    const model = { modelUrl: WEBLLM_MODEL_URL, modelLibUrl: WEBLLM_MODEL_LIB_URL };
    const library = { url: WEBLLM_LIBRARY_URL, integrity: WEBLLM_LIBRARY_INTEGRITY };

    return {
        register,
        ping: () => request('PING'),
        /** Model cache state, library cache state and the storage estimate. */
        status: () => request('STATUS', { model, library }),
        /** Download and verify the WebLLM library into the worker's cache. */
        prepareLibrary: () => request('PREPARE_LIBRARY', { library }),
        /** Delete the model from WebLLM's caches, and the cached library. */
        clearModel: () => request('CLEAR_MODEL', { model, includeLibrary: true })
    };
}
