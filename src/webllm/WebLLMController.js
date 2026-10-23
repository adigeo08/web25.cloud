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

import { WEBLLM_MODEL_DOWNLOAD_BYTES, WEBLLM_PROFILES } from './webllmConfig.js';
import {
    LENGTH_NOTICE,
    LOOP_NOTICE,
    REPLY_LIMIT_NOTICE,
    MESSAGE_TOO_LONG,
    classifyError,
    parseInitProgress,
    selectContextMessages,
    trimHistory
} from './webllmProgress.js';

/** One download per browser, however many WEB25 tabs are open. */
export const WEBLLM_INSTALL_LOCK = 'web25-webllm-install';

/**
 * @typedef {'locked'|'idle'|'checking'|'unsupported'|'not-installed'|'installing'|'ready'|'error'} WebLLMStatus
 * @typedef {'stop'|'length'|'abort'|'loop'|'error'} FinishReason
 *   stop    the model ended its reply
 *   length  it hit the reply length limit (or the context window)
 *   abort   the user pressed Stop
 *   loop    the loop guard ended a repeating reply
 *   error   no reply: the request failed
 * @typedef {{ id: number, role: 'user'|'assistant', content: string, pending: boolean, error: string|null,
 *             stopped: boolean, finishReason: FinishReason|null, notice: string|null }} ChatMessage
 */

function initialState() {
    return {
        /** @type {WebLLMStatus} */
        status: 'locked',
        /**
         * The current model in WebLLM's cache, and `legacyBytes`: how much of
         * an older build (q4f16) is still stored, 0 when none.
         * @type {{ state: 'unknown'|'absent'|'partial'|'installed', percent: number, legacyBytes?: number }}
         */
        cache: { state: 'unknown', percent: 0, legacyBytes: 0 },
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
     *           log?: (message: string) => void,
     *           profile?: import('./webllmConfig.js').WebLLMProfile & { overridden?: boolean } }} deps
     */
    constructor({
        detectWebGPU,
        swClient,
        createEngine,
        storage = null,
        locks = null,
        onChange = () => {},
        log = () => {},
        profile = WEBLLM_PROFILES.desktop
    }) {
        /** Memory profile: context window, reply limit and prompt budget. Fixed for the page's lifetime. */
        this.profile = profile;
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
            if (!model) return { state: 'unknown', percent: 0, legacyBytes: 0 };
            const percent = model.bytesTotal > 0 ? Math.floor((model.bytesCached / model.bytesTotal) * 100) : 0;
            // An older build still in this browser: shown, never removed unasked.
            const legacyBytes = (Array.isArray(status.legacy) ? status.legacy : [])
                .filter((entry) => entry?.state && entry.state !== 'absent')
                .reduce((sum, entry) => sum + Math.max(Number(entry.bytesCached) || 0, 1), 0);
            return {
                state: model.state,
                percent,
                bytesCached: model.bytesCached,
                storage: status.storage || null,
                legacyBytes
            };
        } catch (error) {
            this.log(`WebLLM cache status unavailable: ${error?.message || error}`);
            return { state: 'unknown', percent: 0, legacyBytes: 0 };
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
                }, this.profile);
                this.log(
                    `Loaded with the ${this.profile.id} profile: ${this.profile.contextWindow}-token context, ` +
                        `${this.profile.maxTokens ? `${this.profile.maxTokens}-token replies` : 'no reply limit'}.`
                );
            });
            if (stale()) return;

            this.update({
                status: 'ready',
                cache: { ...this.state.cache, state: 'installed', percent: 100 },
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

    /**
     * The prompt for the next reply: the recent finished exchanges and the new
     * message, trimmed to what the context window can hold. No system message:
     * like chat.webllm.ai, the model gets its conversation template's own.
     *
     * @param {ChatMessage[]} prior the conversation before the new message
     * @param {string} content the new message
     * @param {number} budget estimated tokens the prompt may use
     */
    planPrompt(prior, content, budget) {
        return trimHistory([...selectContextMessages(prior), { role: 'user', content }], { budget });
    }

    /**
     * Ask the engine for a reply — and, if it says the prompt does not fit
     * (the estimate is only an estimate), once more with less of the history.
     *
     * @param {any} engine
     * @param {ChatMessage[]} prior
     * @param {string} content
     * @param {(delta: string) => void} onDelta
     * @param {() => boolean} stale
     */
    async generate(engine, prior, content, onDelta, stale) {
        let sent = null;
        let lastError = null;
        const full = this.profile.promptTokenBudget;
        for (const budget of [full, Math.floor(full * 0.6)]) {
            const plan = this.planPrompt(prior, content, budget);
            if (!plan.fits) throw Object.assign(new Error(MESSAGE_TOO_LONG), { name: 'MessageTooLong' });
            // Nothing more to drop: a second attempt would be the same request.
            if (sent && plan.messages.length === sent.length) break;
            sent = plan.messages;
            try {
                return await engine.chat(sent, onDelta);
            } catch (error) {
                if (stale() || classifyError(error).kind !== 'context') throw error;
                lastError = error;
            }
        }
        throw lastError;
    }

    /**
     * Record how a reply ended.
     * @param {ChatMessage} reply
     * @param {{ finishReason?: string|null, keepChars?: number, usage?: any }|undefined} result
     */
    finishReply(reply, result) {
        const reason = result?.finishReason || 'stop';
        const usage = result?.usage;
        // One line per reply, for comparing profiles on a device: length, speed, ending.
        if (usage) {
            const decode = Number(usage.extra?.decode_tokens_per_s);
            this.log(
                `Reply (${this.profile.id}): ${usage.completion_tokens ?? '?'} tokens, ` +
                    `${Number.isFinite(decode) ? `${decode.toFixed(1)} tok/s` : 'speed n/a'}, finish: ${reason}.`
            );
        }
        reply.finishReason = /** @type {FinishReason} */ (reason);
        if (reason === 'abort') {
            reply.stopped = true;
        } else if (reason === 'loop') {
            // The repeats were streamed before they were recognised; keep the first.
            if (typeof result?.keepChars === 'number') {
                reply.content = reply.content.slice(0, result.keepChars).trimEnd();
            }
            reply.notice = LOOP_NOTICE;
            this.log('WebLLM reply stopped: it was repeating itself.');
        } else if (reason === 'length') {
            // With a reply limit, `length` is that limit — unless usage shows the
            // reply stopped short of it, which means the context window filled.
            const limit = this.profile.maxTokens;
            const hitLimit = Boolean(limit) && !(Number(usage?.completion_tokens) < limit);
            reply.notice = hitLimit ? REPLY_LIMIT_NOTICE : LENGTH_NOTICE;
        }
    }

    /** @param {string} text */
    async send(text) {
        const content = `${text || ''}`.trim();
        if (!content || this.state.status !== 'ready' || this.state.generating || !this.engine) return false;
        const epoch = this.epoch;
        const engine = this.engine;
        const stale = () => epoch !== this.epoch;
        const prior = this.state.messages;

        /** @type {ChatMessage} */
        const user = {
            id: this.nextMessageId++,
            role: 'user',
            content,
            pending: false,
            error: null,
            stopped: false,
            finishReason: null,
            notice: null
        };
        /** @type {ChatMessage} */
        const reply = {
            id: this.nextMessageId++,
            role: 'assistant',
            content: '',
            pending: true,
            error: null,
            stopped: false,
            finishReason: null,
            notice: null
        };

        this.update({ messages: [...prior, user, reply], generating: true }, { type: 'messages' });

        try {
            const result = await this.generate(
                engine,
                prior,
                content,
                (delta) => {
                    if (stale()) return;
                    reply.content += delta;
                    this.onChange(this.state, { type: 'delta', messageId: reply.id });
                },
                stale
            );
            if (stale()) return false;
            this.finishReply(reply, result);
        } catch (error) {
            if (stale()) return false;
            const classified = classifyError(error);
            reply.finishReason = 'error';
            reply.error = error?.name === 'MessageTooLong' ? error.message : classified.message;
            this.log(`WebLLM generation failed: ${classified.detail}`);
            // A crashed worker takes the model with it: back to a reload.
            if (classified.kind === 'resources' || error?.name === 'WorkerCrashed') {
                this.releaseEngine();
                this.update({ status: 'error', error: classified });
            }
        } finally {
            if (!stale()) {
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

    /**
     * Delete the older model build this browser still holds. Only ever run
     * from the user's click: neither installing nor updating removes it.
     */
    async removeLegacyModels() {
        if (!this.allowed || !this.swClient.clearLegacyModels) return;
        const epoch = this.epoch;
        try {
            await this.swClient.clearLegacyModels();
        } catch (error) {
            this.log(`WebLLM could not remove the older model: ${error?.message || error}`);
        }
        const cache = await this.readCache();
        if (epoch !== this.epoch) return;
        // The current model's state is unchanged; only the old build is gone.
        this.update({ cache: { ...this.state.cache, legacyBytes: cache.legacyBytes } });
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
