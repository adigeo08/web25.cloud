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
 * dropped from memory, and any late result from the old session is ignored.
 * The model files stay in Cache Storage for the next unlock.
 *
 * Conversations are saved per wallet (see webllmHistoryStore.js) and come back
 * when the same wallet unlocks again. A development question is first looked
 * up on MDN (see mdnLookup.js), and a reply cut at the length limit can be
 * continued in place.
 *
 * DOM-free: the panel renders `state`, the tests drive it with doubles.
 */

import {
    MDN_CONTEXT_TOKENS,
    WEBLLM_DEFAULT_RETENTION,
    WEBLLM_MESSAGE_FRAMING_TOKENS,
    WEBLLM_MODEL_DOWNLOAD_BYTES,
    WEBLLM_PROFILES,
    WEBLLM_SYSTEM_PROMPT
} from './webllmConfig.js';
import {
    CONTINUE_EXHAUSTED_NOTICE,
    LOOP_NOTICE,
    MDN_UNAVAILABLE_NOTE,
    MESSAGE_TOO_LONG,
    classifyError,
    estimateTokens,
    parseInitProgress,
    selectContextMessages,
    trimHistory
} from './webllmProgress.js';
import { buildSystemPrompt, isDevelopmentQuestion, lookupMdn } from './mdnLookup.js';

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
 * @typedef {{ id: string, role: 'user'|'assistant', content: string, pending: boolean, error: string|null,
 *             stopped: boolean, finishReason: FinishReason|null, notice: string|null,
 *             continuable?: boolean, sources?: { title: string, url: string }[], docContext?: string|null,
 *             lookupNote?: string|null, createdAt?: number }} ChatMessage
 *   continuable  a reply cut at the length limit that Continue can extend
 *   sources      MDN pages the reply was given (shown as links)
 *   docContext   the documentation excerpt it was given, kept so Continue sees it too
 *   lookupNote   why no documentation was used, when a lookup was tried and failed
 */

let idCounter = 0;
function newMessageId() {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    idCounter += 1;
    return `m${Date.now().toString(36)}${idCounter}`;
}

/** @param {'user'|'assistant'} role @param {string} content @returns {ChatMessage} */
function createMessage(role, content) {
    return {
        id: newMessageId(),
        role,
        content,
        pending: role === 'assistant',
        error: null,
        stopped: false,
        finishReason: null,
        notice: null,
        continuable: false,
        sources: [],
        docContext: null,
        lookupNote: null,
        createdAt: Date.now()
    };
}

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
        /** @type {ChatMessage[]} the open conversation */
        messages: [],
        generating: false,
        /** @type {{ id: string, title: string, updatedAt: number }[]} saved conversations, newest first */
        conversations: [],
        /** @type {string|null} the open conversation's id; null for a new, unsaved one */
        activeConversationId: null,
        /** 'off' without a wallet to save under, 'loading', 'ready', or 'unavailable' when IndexedDB failed */
        history: 'off',
        settings: { retention: WEBLLM_DEFAULT_RETENTION, mdnEnabled: true },
        /** @type {'searching'|null} an MDN lookup in progress */
        lookup: null
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
     *           profile?: import('./webllmConfig.js').WebLLMProfile & { overridden?: boolean },
     *           openHistory?: ((walletAddress: string) => Promise<import('./webllmHistoryStore.js').WebLLMHistoryStore>) | null,
     *           mdnClient?: any }} deps
     */
    constructor({
        detectWebGPU,
        swClient,
        createEngine,
        storage = null,
        locks = null,
        onChange = () => {},
        log = () => {},
        profile = WEBLLM_PROFILES.desktop,
        openHistory = null,
        mdnClient = null
    }) {
        /** Opens one wallet's saved conversations; none means nothing is saved. */
        this.openHistory = openHistory;
        /** The MDN MCP client; none means no documentation lookups. */
        this.mdnClient = mdnClient;
        /** @type {import('./webllmHistoryStore.js').WebLLMHistoryStore|null} */
        this.history = null;
        /** @type {string|null} */
        this.walletAddress = null;
        /** The reply being written, so a lock can save what there is of it. */
        this.activeReply = null;
        /** @type {AbortController|null} an MDN lookup Stop can cancel */
        this.lookupAbort = null;
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
    }

    /** @param {Partial<ReturnType<typeof initialState>>} patch */
    update(patch, change = { type: 'state' }) {
        Object.assign(this.state, patch);
        this.onChange(this.state, change);
    }

    /**
     * The wallet gate. Only a signed-in, onboarded identity may use the chat,
     * and only that wallet's saved conversations are opened.
     * @param {boolean} allowed
     * @param {{ walletAddress?: string|null }} [identity]
     */
    setAllowed(allowed, { walletAddress = null } = {}) {
        const wallet = walletAddress ? `${walletAddress}`.toLowerCase() : null;
        if (allowed === this.allowed && (!allowed || wallet === this.walletAddress)) return;
        // Another wallet without a lock in between: close the first one's session.
        if (allowed && this.allowed) this.lock();
        this.allowed = allowed;
        if (allowed) {
            this.walletAddress = wallet;
            this.update({ ...initialState(), status: 'idle' });
            if (wallet && this.openHistory) void this.loadHistory(wallet);
        } else {
            this.lock();
        }
    }

    // ── conversations ───────────────────────────────────────────────────────

    /** Open this wallet's saved conversations and the most recent one. */
    async loadHistory(wallet) {
        const epoch = this.epoch;
        this.update({ history: 'loading' });
        let store = null;
        try {
            store = await this.openHistory(wallet);
            const settings = await store.getSettings();
            const conversations = await store.listConversations();
            if (epoch !== this.epoch) {
                store.close();
                return;
            }
            this.history = store;
            this.update({ history: 'ready', settings, conversations: conversations.map(summary) });
            if (conversations.length > 0 && !this.state.activeConversationId && this.state.messages.length === 0) {
                await this.openConversation(conversations[0].id);
            }
        } catch (error) {
            if (epoch !== this.epoch) return;
            store?.close();
            this.log(`WebLLM chat history unavailable: ${error?.message || error}`);
            this.update({ history: 'unavailable' });
        }
    }

    /** Re-read the list, which also drops conversations past retention. */
    async refreshConversations() {
        if (!this.history) return;
        const epoch = this.epoch;
        try {
            const conversations = await this.history.listConversations();
            if (epoch !== this.epoch) return;
            const patch = { conversations: conversations.map(summary) };
            const active = this.state.activeConversationId;
            // The open conversation expired: it is gone from screen too.
            if (active && !conversations.some((entry) => entry.id === active) && !this.state.generating) {
                Object.assign(patch, { activeConversationId: null, messages: [] });
            }
            this.update(patch, { type: 'messages' });
        } catch (error) {
            this.log(`WebLLM chat history could not be read: ${error?.message || error}`);
        }
    }

    /** @param {string} conversationId */
    async openConversation(conversationId) {
        if (!this.history || !this.allowed) return;
        if (conversationId === this.state.activeConversationId && !this.state.generating) return;
        this.stop();
        const epoch = this.epoch;
        try {
            const rows = await this.history.getMessages(conversationId);
            if (epoch !== this.epoch) return;
            const messages = rows.map(restoreMessage);
            this.update({ activeConversationId: conversationId, messages }, { type: 'messages' });
            await this.refreshConversations();
        } catch (error) {
            this.log(`WebLLM conversation could not be opened: ${error?.message || error}`);
        }
    }

    /** A new, empty conversation. It is saved once it has a first message. */
    newChat() {
        this.stop();
        this.update({ activeConversationId: null, messages: [] }, { type: 'messages' });
    }

    /**
     * Delete one saved conversation — never the model.
     * @param {string|null} [conversationId] the open one by default
     */
    async deleteConversation(conversationId = this.state.activeConversationId) {
        const isActive = conversationId === this.state.activeConversationId;
        if (isActive) this.stop();
        if (!conversationId) {
            // Nothing saved yet: clearing the screen is the whole deletion.
            if (isActive) this.update({ messages: [] }, { type: 'messages' });
            return;
        }
        const epoch = this.epoch;
        try {
            await this.history?.deleteConversation(conversationId);
        } catch (error) {
            this.log(`WebLLM conversation could not be deleted: ${error?.message || error}`);
            return;
        }
        if (epoch !== this.epoch) return;
        const conversations = this.state.conversations.filter((entry) => entry.id !== conversationId);
        if (isActive) {
            this.update({ conversations, activeConversationId: null, messages: [] }, { type: 'messages' });
            if (conversations.length > 0) await this.openConversation(conversations[0].id);
        } else {
            this.update({ conversations }, { type: 'messages' });
        }
    }

    /** @param {string} retention one of WEBLLM_RETENTION_OPTIONS */
    async setRetention(retention) {
        const settings = { ...this.state.settings, retention };
        this.update({ settings });
        if (!this.history) return;
        try {
            await this.history.setSetting('retention', retention);
        } catch (error) {
            this.log(`WebLLM retention could not be saved: ${error?.message || error}`);
        }
        await this.refreshConversations();
    }

    /** @param {boolean} enabled */
    async setMdnEnabled(enabled) {
        this.update({ settings: { ...this.state.settings, mdnEnabled: Boolean(enabled) } });
        try {
            await this.history?.setSetting('mdnEnabled', Boolean(enabled));
        } catch (error) {
            this.log(`WebLLM MDN preference could not be saved: ${error?.message || error}`);
        }
    }

    /**
     * Save a message, best-effort: a chat never fails because history did.
     * @param {string|null} conversationId
     * @param {ChatMessage} message
     */
    persist(conversationId, message) {
        if (!this.history || !conversationId) return Promise.resolve();
        return this.history.saveMessage(conversationId, message).catch((error) => {
            this.log(`WebLLM message could not be saved: ${error?.message || error}`);
        });
    }

    /** Make sure the open conversation exists in storage, titled from its first message. */
    async ensureConversation(firstMessage) {
        if (this.state.activeConversationId || !this.history) return this.state.activeConversationId;
        try {
            const conversation = await this.history.createConversation(firstMessage);
            this.update({
                activeConversationId: conversation.id,
                conversations: [summary(conversation), ...this.state.conversations]
            });
            return conversation.id;
        } catch (error) {
            this.log(`WebLLM conversation could not be saved: ${error?.message || error}`);
            return null;
        }
    }

    /** Move a conversation to the top of the list: it was just used. */
    touchConversation(conversationId) {
        const entry = this.state.conversations.find((item) => item.id === conversationId);
        if (!entry) return;
        const touched = { ...entry, updatedAt: Date.now() };
        this.update({
            conversations: [touched, ...this.state.conversations.filter((item) => item.id !== conversationId)]
        });
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
     * The prompt for the next reply: the system prompt (with any documentation),
     * the recent finished exchanges and the new message, trimmed to what the
     * context window can hold.
     *
     * @param {ChatMessage[]} prior the conversation before the new message
     * @param {string} content the new message
     * @param {number} budget estimated tokens the prompt may use
     * @param {string} [system]
     */
    planPrompt(prior, content, budget, system = WEBLLM_SYSTEM_PROMPT) {
        return trimHistory(
            [{ role: 'system', content: system }, ...selectContextMessages(prior), { role: 'user', content }],
            { budget }
        );
    }

    /**
     * Ask the engine for a reply. If the documentation makes the prompt too
     * big it is left out; if the engine says the prompt does not fit (the
     * estimate is only an estimate), it is asked once more with less history.
     *
     * @param {any} engine
     * @param {ChatMessage[]} prior
     * @param {string} content
     * @param {(delta: string) => void} onDelta
     * @param {() => boolean} stale
     * @param {string[]} systems system prompts to try, richest first
     * @returns {Promise<{ result: any, system: string }>}
     */
    async generate(engine, prior, content, onDelta, stale, systems = [WEBLLM_SYSTEM_PROMPT]) {
        let sent = null;
        let lastError = null;
        const full = this.profile.promptTokenBudget;
        const system = systems.find((candidate) => this.planPrompt(prior, content, full, candidate).fits);
        if (system === undefined) throw Object.assign(new Error(MESSAGE_TOO_LONG), { name: 'MessageTooLong' });
        for (const budget of [full, Math.floor(full * 0.6)]) {
            const plan = this.planPrompt(prior, content, budget, system);
            if (!plan.fits) break;
            // Nothing more to drop: a second attempt would be the same request.
            if (sent && plan.messages.length === sent.length) break;
            sent = plan.messages;
            try {
                return { result: await engine.chat(sent, onDelta), system };
            } catch (error) {
                if (stale() || classifyError(error).kind !== 'context') throw error;
                lastError = error;
            }
        }
        throw lastError || Object.assign(new Error(MESSAGE_TOO_LONG), { name: 'MessageTooLong' });
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
        reply.continuable = false;
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
            // Cut at the reply limit (or a full window): Continue picks it up —
            // if there is still room to.
            reply.continuable = this.continuationPlan(reply) !== null;
            if (!reply.continuable) reply.notice = CONTINUE_EXHAUSTED_NOTICE;
        }
    }

    /**
     * Look the question up on MDN, if it is a development question and lookups
     * are on. Never throws: no documentation is a normal outcome.
     *
     * @param {string} content
     * @param {ChatMessage} reply
     * @param {() => boolean} stale
     * @returns {Promise<import('./mdnLookup.js').MdnLookup|null>}
     */
    async lookupDocumentation(content, reply, stale) {
        if (!this.mdnClient || !this.state.settings.mdnEnabled || !isDevelopmentQuestion(content)) return null;
        // Leave the documentation no more than the budget can spare after the
        // system prompt and the question itself.
        const room =
            this.profile.promptTokenBudget -
            estimateTokens(WEBLLM_SYSTEM_PROMPT) -
            estimateTokens(content) -
            4 * WEBLLM_MESSAGE_FRAMING_TOKENS -
            96;
        const maxTokens = Math.min(MDN_CONTEXT_TOKENS[this.profile.id] ?? MDN_CONTEXT_TOKENS.desktop, room);
        if (maxTokens < 80) return null;

        this.lookupAbort = new AbortController();
        this.update({ lookup: 'searching' });
        try {
            return await lookupMdn(this.mdnClient, content, { maxTokens, signal: this.lookupAbort.signal });
        } catch (error) {
            if (!stale() && error?.kind !== 'aborted') {
                reply.lookupNote = MDN_UNAVAILABLE_NOTE;
                this.log(`MDN lookup failed: ${error?.message || error}`);
            }
            return null;
        } finally {
            this.lookupAbort = null;
            if (!stale()) this.update({ lookup: null });
        }
    }

    /** @param {string} text */
    async send(text) {
        const content = `${text || ''}`.trim();
        if (!content || this.state.status !== 'ready' || this.state.generating || !this.engine) return false;
        const epoch = this.epoch;
        const engine = this.engine;
        const stale = () => epoch !== this.epoch;

        const user = createMessage('user', content);
        user.pending = false;
        const reply = createMessage('assistant', '');
        // Shown at once; saved once the conversation exists.
        const prior = this.state.messages;
        this.update({ messages: [...prior, user, reply], generating: true }, { type: 'messages' });
        const conversationId = await this.ensureConversation(content);
        if (stale()) return false;
        void this.persist(conversationId, user);
        this.activeReply = { conversationId, reply };

        try {
            const lookup = await this.lookupDocumentation(content, reply, stale);
            if (stale()) return false;
            if (reply.stopped) {
                // Stop during the lookup: nothing was generated.
                this.finishReply(reply, { finishReason: 'abort' });
                return true;
            }
            const withDocs = buildSystemPrompt(WEBLLM_SYSTEM_PROMPT, lookup);
            const { result, system } = await this.generate(
                engine,
                prior,
                content,
                (delta) => {
                    if (stale()) return;
                    reply.content += delta;
                    this.onChange(this.state, { type: 'delta', messageId: reply.id });
                },
                stale,
                lookup ? [withDocs, WEBLLM_SYSTEM_PROMPT] : [WEBLLM_SYSTEM_PROMPT]
            );
            if (stale()) return false;
            // Documentation is credited only if it was actually in the prompt.
            if (lookup && system === withDocs) {
                reply.sources = lookup.sources;
                reply.docContext = lookup.context;
            }
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
                this.activeReply = null;
                void this.persist(conversationId, reply);
                if (conversationId) this.touchConversation(conversationId);
                this.update({ generating: false }, { type: 'messages' });
            }
        }
        return true;
    }

    /**
     * What a continuation of `reply` would send, or null when there is no room
     * left: the system prompt (with the documentation the reply had, if it
     * still fits), the history before its question, the question, and the
     * reply so far — which must leave the profile's reply room free.
     *
     * @param {ChatMessage} reply
     * @returns {{ messages: { role: string, content: string }[], partial: string } | null}
     */
    continuationPlan(reply) {
        const messages = this.state.messages;
        const index = messages.indexOf(reply);
        const question = index > 0 ? messages[index - 1] : null;
        if (!question || question.role !== 'user') return null;
        const budget = this.profile.promptTokenBudget - estimateTokens(reply.content) - WEBLLM_MESSAGE_FRAMING_TOKENS;
        const lookup = reply.docContext ? { context: reply.docContext, sources: reply.sources || [] } : null;
        const systems = lookup
            ? [buildSystemPrompt(WEBLLM_SYSTEM_PROMPT, lookup), WEBLLM_SYSTEM_PROMPT]
            : [WEBLLM_SYSTEM_PROMPT];
        for (const system of systems) {
            const plan = this.planPrompt(messages.slice(0, index - 1), question.content, budget, system);
            if (plan.fits) return { messages: plan.messages, partial: reply.content };
        }
        return null;
    }

    /**
     * Continue a reply that stopped at the length limit, in the same message:
     * the model picks up exactly where the text ends, and what it writes is
     * appended. On a phone each continuation is again at most 256 tokens.
     *
     * @param {string} messageId
     */
    async continueReply(messageId) {
        if (this.state.status !== 'ready' || this.state.generating || !this.engine) return false;
        const messages = this.state.messages;
        const reply = messages[messages.length - 1];
        if (!reply || reply.id !== messageId || reply.role !== 'assistant' || !reply.continuable) return false;
        const epoch = this.epoch;
        const engine = this.engine;
        const stale = () => epoch !== this.epoch;
        const conversationId = this.state.activeConversationId;

        const plan = this.continuationPlan(reply);
        if (!plan) {
            reply.continuable = false;
            reply.notice = CONTINUE_EXHAUSTED_NOTICE;
            void this.persist(conversationId, reply);
            this.update({}, { type: 'messages' });
            return false;
        }

        Object.assign(reply, { pending: true, continuable: false, notice: null, finishReason: null });
        this.activeReply = { conversationId, reply };
        this.update({ generating: true }, { type: 'messages' });
        try {
            const result = await engine.continue(plan.messages, plan.partial, (delta) => {
                if (stale()) return;
                reply.content += delta;
                this.onChange(this.state, { type: 'delta', messageId: reply.id });
            });
            if (stale()) return false;
            this.finishReply(reply, result);
        } catch (error) {
            if (stale()) return false;
            const classified = classifyError(error);
            // What was already written stays; the reply just cannot go further now.
            reply.finishReason = 'length';
            reply.continuable = classified.kind !== 'context';
            reply.notice = classified.kind === 'context' ? CONTINUE_EXHAUSTED_NOTICE : classified.message;
            this.log(`WebLLM continuation failed: ${classified.detail}`);
        } finally {
            if (!stale()) {
                reply.pending = false;
                this.activeReply = null;
                void this.persist(conversationId, reply);
                if (conversationId) this.touchConversation(conversationId);
                this.update({ generating: false }, { type: 'messages' });
            }
        }
        return true;
    }

    stop() {
        if (!this.state.generating) return;
        // During a lookup there is no generation yet: cancel the lookup.
        if (this.lookupAbort) {
            if (this.activeReply) this.activeReply.reply.stopped = true;
            this.lookupAbort.abort();
        }
        this.engine?.interrupt();
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
     * resources, the conversation, any in-flight download or reply. What had
     * been written of a reply is saved as interrupted; saved conversations
     * and the cached model files stay where they are.
     */
    /**
     * The page is going away (tab closed, navigated, frozen): keep what there
     * is of a reply being written, marked as interrupted. Nothing else changes.
     */
    saveInterruptedReply() {
        if (this.history) void saveInterrupted(this.history, this.activeReply);
    }

    lock() {
        this.epoch += 1;
        this.installing = null;
        this.checking = null;
        this.lookupAbort?.abort();
        this.lookupAbort = null;
        const history = this.history;
        const active = this.activeReply;
        this.history = null;
        this.activeReply = null;
        this.walletAddress = null;
        if (history) void saveInterrupted(history, active).finally(() => history.close());
        this.releaseEngine();
        this.state = initialState();
        this.onChange(this.state, { type: 'state' });
    }
}

/**
 * Save a reply cut off mid-generation as stopped.
 * @param {import('./webllmHistoryStore.js').WebLLMHistoryStore} history
 * @param {{ conversationId: string|null, reply: ChatMessage }|null} active
 */
function saveInterrupted(history, active) {
    if (!active?.conversationId || !active.reply.content) return Promise.resolve();
    return history
        .saveMessage(active.conversationId, {
            ...active.reply,
            pending: false,
            stopped: true,
            finishReason: 'abort',
            continuable: false
        })
        .catch(() => {});
}

/** A conversation as the list shows it. */
function summary(conversation) {
    return { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt };
}

/**
 * A saved message, back as a chat message. A reply saved mid-generation
 * comes back as stopped: it will never be finished.
 * @returns {ChatMessage}
 */
function restoreMessage(row) {
    return {
        id: row.id,
        role: row.role,
        content: row.content,
        pending: false,
        error: row.error || null,
        stopped: Boolean(row.stopped),
        finishReason: row.finishReason || (row.role === 'assistant' ? 'abort' : null),
        notice: row.notice || null,
        continuable: row.finishReason === 'length' && !row.notice,
        sources: Array.isArray(row.sources) ? row.sources : [],
        docContext: row.docContext || null,
        lookupNote: row.lookupNote || null,
        createdAt: row.createdAt
    };
}
