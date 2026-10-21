// @ts-check
/**
 * The local AI chat's state machine.
 *
 *   locked ─unlock─▶ idle ─open tab─▶ checking ─┬▶ unsupported
 *                                               ├▶ not-installed ─Install─▶ installing ─▶ ready
 *                                               └▶ (model cached) ──────────▶ installing ─▶ ready
 *                                                                    error ◀──┘   (Retry ↺)
 *
 * Nothing here runs until the WebLLM tab is opened, and nothing is downloaded
 * until Install is pressed — or, in a later session, until the tab is opened
 * with the model already in this browser, when it loads from the cache.
 *
 * Locking the wallet ends the session: generation stops, the engine is
 * released (its worker terminated, which frees the GPU), the conversation is
 * dropped, and any late result from the old session is ignored. The model
 * files stay in Cache Storage for the next unlock.
 *
 * DOM-free: the panel renders `state`, the tests drive it with doubles.
 */

import { WEBLLM_MODEL_DOWNLOAD_BYTES, WEBLLM_SYSTEM_PROMPT } from './webllmConfig.js';
import { classifyError, parseInitProgress, trimHistory } from './webllmProgress.js';

/** One download per browser, however many WEB25 tabs are open. */
export const WEBLLM_INSTALL_LOCK = 'web25-webllm-install';

/**
 * @typedef {'locked'|'idle'|'checking'|'unsupported'|'not-installed'|'installing'|'ready'|'error'} WebLLMStatus
 * @typedef {{ id: number, role: 'user'|'assistant', content: string, pending: boolean, error: string|null, stopped: boolean }} ChatMessage
 */

function initialState() {
    return {
        /** @type {WebLLMStatus} */
        status: 'locked',
        /** @type {{ state: 'unknown'|'absent'|'partial'|'installed', percent: number }} */
        cache: { state: 'unknown', percent: 0 },
        /** Loading weights that are already here, rather than downloading them. */
        fromCache: false,
        /** @type {import('./webllmProgress.js').LoadProgress|null} */
        progress: null,
        waitingForOtherTab: false,
        /** @type {import('./webllmProgress.js').ClassifiedError|null} */
        error: null,
        /** @type {import('./webgpuSupport.js').WebGPUSupport|null} */
        gpu: null,
        /** @type {'worker'|'page'|null} */
        engineKind: null,
        /** @type {ChatMessage[]} */
        messages: [],
        generating: false
    };
}

export class WebLLMController {
    /**
     * @param {{ detectWebGPU: () => Promise<import('./webgpuSupport.js').WebGPUSupport>,
     *           swClient: { status: () => Promise<any>, prepareLibrary: () => Promise<any>, clearModel: () => Promise<any> },
     *           createEngine: () => Promise<any>,
     *           storage?: { estimate?: () => Promise<{ usage?: number, quota?: number }>, persist?: () => Promise<boolean> } | null,
     *           locks?: { request: Function } | null,
     *           onChange?: (state: any, change: { type: string, messageId?: number }) => void,
     *           log?: (message: string) => void }} deps
     */
    constructor({
        detectWebGPU,
        swClient,
        createEngine,
        storage = null,
        locks = null,
        onChange = () => {},
        log = () => {}
    }) {
        this.detectWebGPU = detectWebGPU;
        this.swClient = swClient;
        this.createEngine = createEngine;
        this.storage = storage;
        this.locks = locks;
        this.onChange = onChange;
        this.log = log;

        this.state = initialState();
        this.allowed = false;
        /** Bumped by every lock: work started under an older epoch is discarded. */
        this.epoch = 0;
        /** @type {Promise<void>|null} */
        this.installing = null;
        /** @type {Promise<void>|null} */
        this.checking = null;
        /** @type {any} */
        this.engine = null;
        /** @type {AbortController|null} */
        this.lockAbort = null;
        this.nextMessageId = 1;
    }

    /** @param {Partial<ReturnType<typeof initialState>>} patch */
    update(patch, change = { type: 'state' }) {
        Object.assign(this.state, patch);
        this.onChange(this.state, change);
    }

    /**
     * The wallet gate. Only a signed-in, onboarded identity may use the chat.
     * @param {boolean} allowed
     */
    setAllowed(allowed) {
        if (allowed === this.allowed) return;
        this.allowed = allowed;
        if (allowed) {
            this.update({ ...initialState(), status: 'idle' });
        } else {
            this.lock();
        }
    }

    /** The tab was opened: find out what this device has, and continue from there. */
    activate() {
        if (!this.allowed) return Promise.resolve();
        if (this.state.status === 'idle') return this.check();
        return this.checking || Promise.resolve();
    }

    check() {
        if (this.checking) return this.checking;
        const epoch = this.epoch;
        this.update({ status: 'checking', error: null });
        this.checking = (async () => {
            const gpu = await this.detectWebGPU();
            if (epoch !== this.epoch) return;
            if (!gpu.supported) {
                this.update({
                    status: 'unsupported',
                    gpu,
                    error: { ...classifyError({ name: 'WebGPUNotAvailableError', message: gpu.reason || '' }) }
                });
                return;
            }

            const cache = await this.readCache();
            if (epoch !== this.epoch) return;
            this.update({ gpu, cache });

            // A later session: the model is already here, so there is nothing to
            // install — it loads from the cache straight away.
            if (cache.state === 'installed') {
                await this.install();
                return;
            }
            this.update({ status: 'not-installed' });
        })()
            .catch((error) => {
                if (epoch !== this.epoch) return;
                this.update({ status: 'error', error: classifyError(error) });
            })
            .finally(() => {
                // Only this session's check: a lock may have started another.
                if (epoch === this.epoch) this.checking = null;
            });
        return this.checking;
    }

    /** What the WebLLM service worker can see in WebLLM's caches. */
    async readCache() {
        try {
            const status = await this.swClient.status();
            const model = status?.model;
            if (!model) return { state: 'unknown', percent: 0 };
            const percent = model.bytesTotal > 0 ? Math.floor((model.bytesCached / model.bytesTotal) * 100) : 0;
            return { state: model.state, percent, bytesCached: model.bytesCached, storage: status.storage || null };
        } catch (error) {
            this.log(`WebLLM cache status unavailable: ${error?.message || error}`);
            return { state: 'unknown', percent: 0 };
        }
    }

    /**
     * Download (if needed) and start the model. Pressing Install twice, or
     * Install while a cached load is already running, joins the same run.
     */
    install() {
        if (!this.allowed) return Promise.resolve();
        if (this.state.status === 'ready') return Promise.resolve();
        if (this.state.status === 'unsupported') return Promise.resolve();
        if (!this.installing) {
            const epoch = this.epoch;
            this.installing = this.runInstall(epoch).finally(() => {
                if (epoch === this.epoch) this.installing = null;
            });
        }
        return this.installing;
    }

    /** @param {number} epoch */
    async runInstall(epoch) {
        const stale = () => epoch !== this.epoch;
        const fromCache = this.state.cache.state === 'installed';
        this.update({
            status: 'installing',
            fromCache,
            error: null,
            waitingForOtherTab: false,
            progress: { phase: 'init', percent: 0, loadedMB: null, totalMB: null, shard: null, shards: null, text: '' }
        });

        try {
            const gpu = this.state.gpu?.supported ? this.state.gpu : await this.detectWebGPU();
            if (stale()) return;
            if (!gpu.supported) {
                this.update({
                    status: 'unsupported',
                    gpu,
                    error: classifyError({ name: 'WebGPUNotAvailableError', message: gpu.reason || '' })
                });
                return;
            }
            this.update({ gpu });

            if (!fromCache) await this.checkStorage();
            if (stale()) return;
            // Best-effort: ask the browser not to evict the model under storage
            // pressure, so it is still here next session.
            void Promise.resolve()
                .then(() => this.storage?.persist?.())
                .catch(() => false);

            await this.withInstallLock(epoch, async () => {
                // The library goes into the WebLLM service worker's cache first,
                // so the worker reads it from there now and in later sessions.
                try {
                    await this.swClient.prepareLibrary();
                } catch (error) {
                    this.log(`WebLLM library not cached by the service worker: ${error?.message || error}`);
                }
                if (stale()) return;

                const engine = await this.createEngine();
                if (stale()) {
                    engine.dispose();
                    return;
                }
                this.engine = engine;
                this.update({ engineKind: engine.kind || null });

                await engine.load((report) => {
                    if (stale()) return;
                    this.update({ progress: parseInitProgress(report) }, { type: 'progress' });
                });
            });
            if (stale()) return;

            this.update({
                status: 'ready',
                cache: { state: 'installed', percent: 100 },
                progress: {
                    phase: 'done',
                    percent: 100,
                    loadedMB: null,
                    totalMB: null,
                    shard: null,
                    shards: null,
                    text: ''
                },
                waitingForOtherTab: false
            });
        } catch (error) {
            if (stale()) return;
            this.releaseEngine();
            const classified = classifyError(error);
            this.log(`WebLLM install failed: ${classified.detail}`);
            // What survived of the download decides what the retry will say.
            const cache = await this.readCache();
            if (stale()) return;
            this.update({
                status: classified.kind === 'unsupported' ? 'unsupported' : 'error',
                error: classified,
                cache,
                waitingForOtherTab: false
            });
        }
    }

    /** Refuse to start a download the browser has no room for. */
    async checkStorage() {
        let estimate = null;
        try {
            estimate = await this.storage?.estimate?.();
        } catch (_) {
            estimate = null;
        }
        if (!estimate?.quota) return;
        const already = Number(this.state.cache?.bytesCached) || 0;
        const needed = Math.max(0, WEBLLM_MODEL_DOWNLOAD_BYTES - already);
        const free = estimate.quota - (Number(estimate.usage) || 0);
        if (free < needed) {
            throw Object.assign(new Error(`Not enough storage: ${Math.floor(free / 1048576)} MB free`), {
                name: 'QuotaExceededError'
            });
        }
    }

    /**
     * Hold the browser-wide install lock while downloading, so two WEB25 tabs
     * never fetch the same weights at once. The second tab waits, then loads
     * what the first one cached.
     * @param {number} epoch
     * @param {() => Promise<void>} work
     */
    async withInstallLock(epoch, work) {
        if (!this.locks?.request) return work();

        const free = await this.locks.request(WEBLLM_INSTALL_LOCK, { ifAvailable: true }, async (lock) => {
            if (!lock) return false;
            await work();
            return true;
        });
        if (free) return;

        if (epoch !== this.epoch) return;
        this.update({ waitingForOtherTab: true });
        this.lockAbort = new AbortController();
        try {
            await this.locks.request(WEBLLM_INSTALL_LOCK, { signal: this.lockAbort.signal }, async () => {
                if (epoch !== this.epoch) return;
                this.update({ waitingForOtherTab: false, fromCache: true });
                await work();
            });
        } finally {
            this.lockAbort = null;
        }
    }

    retry() {
        if (this.state.status !== 'error') return Promise.resolve();
        return this.install();
    }

    /** @param {string} text */
    async send(text) {
        const content = `${text || ''}`.trim();
        if (!content || this.state.status !== 'ready' || this.state.generating || !this.engine) return false;
        const epoch = this.epoch;
        const engine = this.engine;

        /** @type {ChatMessage} */
        const user = { id: this.nextMessageId++, role: 'user', content, pending: false, error: null, stopped: false };
        /** @type {ChatMessage} */
        const reply = {
            id: this.nextMessageId++,
            role: 'assistant',
            content: '',
            pending: true,
            error: null,
            stopped: false
        };

        // The model sees only finished turns, never an error or a half reply.
        const history = trimHistory([
            { role: 'system', content: WEBLLM_SYSTEM_PROMPT },
            ...this.state.messages
                .filter((message) => !message.error && !message.pending && message.content)
                .map(({ role, content: body }) => ({ role, content: body })),
            { role: 'user', content }
        ]);

        this.update({ messages: [...this.state.messages, user, reply], generating: true }, { type: 'messages' });

        try {
            const result = await engine.chat(history, (delta) => {
                if (epoch !== this.epoch) return;
                reply.content += delta;
                this.onChange(this.state, { type: 'delta', messageId: reply.id });
            });
            if (epoch !== this.epoch) return false;
            if (result?.finishReason === 'abort') reply.stopped = true;
        } catch (error) {
            if (epoch !== this.epoch) return false;
            const classified = classifyError(error);
            reply.error = classified.message;
            this.log(`WebLLM generation failed: ${classified.detail}`);
            // A crashed worker takes the model with it: back to a reload.
            if (classified.kind === 'resources' || error?.name === 'WorkerCrashed') {
                this.releaseEngine();
                this.update({ status: 'error', error: classified });
            }
        } finally {
            if (epoch === this.epoch) {
                reply.pending = false;
                this.update({ generating: false }, { type: 'messages' });
            }
        }
        return true;
    }

    stop() {
        if (this.state.generating) this.engine?.interrupt();
    }

    newChat() {
        this.stop();
        this.update({ messages: [] }, { type: 'messages' });
    }

    /**
     * Delete the downloaded model from this browser. The only path that does:
     * locking the wallet keeps it.
     */
    async removeModel() {
        this.epoch += 1;
        this.installing = null;
        this.releaseEngine();
        try {
            await this.swClient.clearModel();
        } catch (error) {
            this.log(`WebLLM model removal failed: ${error?.message || error}`);
        }
        const cache = await this.readCache();
        if (!this.allowed) return;
        this.update({
            ...initialState(),
            status: 'not-installed',
            gpu: this.state.gpu,
            cache
        });
    }

    releaseEngine() {
        this.lockAbort?.abort();
        this.lockAbort = null;
        if (this.engine) {
            this.engine.interrupt?.();
            this.engine.dispose();
        }
        this.engine = null;
    }

    /**
     * The wallet was locked. Everything in memory goes: the engine and its GPU
     * resources, the conversation, any in-flight download or reply. The cached
     * model files are left exactly where they are.
     */
    lock() {
        this.epoch += 1;
        this.installing = null;
        this.checking = null;
        this.releaseEngine();
        this.state = initialState();
        this.onChange(this.state, { type: 'state' });
    }
}
