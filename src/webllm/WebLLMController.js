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
 * How a reply is written is a chat setting (see webllmThinking.js): Short is
 * one answer in a small token window; Thinking is a plan and then one step at
 * a time, each with its own MDN lookup, each kept as a thought in the thought
 * store (webllmThoughtStore.js) from which later steps recall what they need;
 * Auto lets the model choose per message. The model — Llama 3.2 1B on a
 * desktop, SmolLM2 360M on a phone or tablet (see `WEBLLM_PROFILES`) — only
 * ever runs on the GPU; the thought store and its similarity search are plain
 * JavaScript on the CPU.
 *
 * DOM-free: the panel renders `state`, the tests drive it with doubles.
 */

import {
    MDN_CONTEXT_TOKENS,
    WEBLLM_DEFAULT_REPLY_MODE,
    WEBLLM_DEFAULT_RETENTION,
    WEBLLM_REPLY_MODES,
    WEBLLM_MESSAGE_FRAMING_TOKENS,
    WEBLLM_PROFILES,
    WEBLLM_SYSTEM_PROMPT,
    WEBLLM_THINKING,
    getWebLLMModel
} from './webllmConfig.js';
import {
    CONTINUE_EXHAUSTED_NOTICE,
    MDN_UNAVAILABLE_NOTE,
    MESSAGE_TOO_LONG,
    classifyError,
    estimateTokens,
    parseInitProgress,
    selectContextMessages,
    trimHistory
} from './webllmProgress.js';
import { buildSystemPrompt, isDevelopmentQuestion, lookupMdn } from './mdnLookup.js';
import {
    MODE_SCHEMA,
    MODE_SYSTEM_PROMPT,
    PLAN_SCHEMA,
    SHORT_SYSTEM_PROMPT,
    closeOpenFence,
    formatPlan,
    formatRecall,
    incompleteStepMarker,
    parseModeDecision,
    parsePlan,
    planInstruction,
    stepConfirmed,
    stepHeading,
    stepInstruction,
    stepMessage,
    stepStatus
} from './webllmThinking.js';

/**
 * Said under a Thinking reply with steps that did not finish. Each such step
 * also carries its own line in the reply; the next steps are not shown its code.
 * @param {number[]} steps one-based
 */
export function stepIncompleteNotice(steps) {
    const one = steps.length === 1;
    return (
        `${one ? `Step ${steps[0]}` : `Steps ${steps.join(', ')}`} did not finish and ${one ? 'is' : 'are'} ` +
        `marked incomplete; the remaining steps were still written without relying on ${one ? 'it' : 'them'}.`
    );
}

/** One download per browser, however many WEB25 tabs are open. */
export const WEBLLM_INSTALL_LOCK = 'web25-webllm-install';

/**
 * @typedef {'locked'|'idle'|'checking'|'unsupported'|'not-installed'|'installing'|'ready'|'error'} WebLLMStatus
 * @typedef {'stop'|'length'|'abort'|'loop'|'error'} FinishReason
 *   stop    the model ended its reply
 *   length  it hit the reply length limit (or the context window)
 *   abort   the user pressed Stop
 *   loop    only in conversations saved while a loop guard still cut replies;
 *           such a reply is never passed back as context
 *   error   no reply: the request failed
 * @typedef {{ id: string, role: 'user'|'assistant', content: string, pending: boolean, error: string|null,
 *             stopped: boolean, finishReason: FinishReason|null, notice: string|null,
 *             continuable?: boolean, sources?: { title: string, url: string }[], docContext?: string|null,
 *             lookupNote?: string|null, createdAt?: number,
 *             mode?: import('./webllmThinking.js').ReplyMode|null, autoMode?: boolean, steps?: number,
 *             sequenceId?: string|null }} ChatMessage
 *   continuable  a reply cut at the length limit that Continue can extend
 *   sources      MDN pages the reply was given (shown as links)
 *   docContext   the documentation excerpt it was given, kept so Continue sees it too
 *   lookupNote   why no documentation was used, when a lookup was tried and failed
 *   mode         how the reply was written: short, or thinking in steps
 *   autoMode     whether the model chose that mode (the Auto setting)
 *   steps        how many planned steps a thinking reply was written in (0: no plan)
 *   sequenceId   the thought sequence a thinking reply was kept as
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
        mode: null,
        autoMode: false,
        steps: 0,
        sequenceId: null,
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
        settings: {
            retention: WEBLLM_DEFAULT_RETENTION,
            mdnEnabled: true,
            engine: null,
            replyMode: WEBLLM_DEFAULT_REPLY_MODE
        },
        /** @type {'searching'|null} an MDN lookup in progress */
        lookup: null,
        /** @type {string[]} models removed from this browser to make room for this one (on a phone, Llama) */
        replaced: [],
        /**
         * Where the reply being written is in its sequence, for the status line.
         * @type {{ mode: 'auto'|import('./webllmThinking.js').ReplyMode,
         *          phase: 'deciding'|'planning'|'lookup'|'recall'|'writing', step: number, total: number }|null}
         */
        thinking: null
    };
}

export class WebLLMController {
    /**
     * @param {{ detectWebGPU: () => Promise<import('./webgpuSupport.js').WebGPUSupport>,
     *           swClient: { status: () => Promise<any>, prepareLibrary: () => Promise<any>, clearModel: () => Promise<any> },
     *           createEngine: (options?: { preferred: 'worker'|'page'|null }) => Promise<any>,
     *           storage?: { estimate?: () => Promise<{ usage?: number, quota?: number }>, persist?: () => Promise<boolean> } | null,
     *           locks?: { request: Function } | null,
     *           onChange?: (state: any, change: { type: string, messageId?: number }) => void,
     *           log?: (message: string) => void,
     *           profile?: import('./webllmConfig.js').WebLLMProfile & { overridden?: boolean },
     *           openHistory?: ((walletAddress: string) => Promise<import('./webllmHistoryStore.js').WebLLMHistoryStore>) | null,
     *           openThoughts?: ((walletAddress: string) => Promise<import('./webllmThoughtStore.js').WebLLMThoughtStore>) | null,
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
        openThoughts = null,
        mdnClient = null
    }) {
        /** Opens one wallet's saved conversations; none means nothing is saved. */
        this.openHistory = openHistory;
        /** Opens one wallet's thought store; none means thinking replies keep no thoughts. */
        this.openThoughts = openThoughts;
        /** @type {import('./webllmThoughtStore.js').WebLLMThoughtStore|null} */
        this.thoughts = null;
        /** The MDN MCP client; none means no documentation lookups. */
        this.mdnClient = mdnClient;
        /** @type {import('./webllmHistoryStore.js').WebLLMHistoryStore|null} */
        this.history = null;
        /** @type {string|null} */
        this.walletAddress = null;
        /** @type {string|null} the signed-in identity's Nostr address (npub), the author of project commits */
        this.npub = null;
        /** The reply being written, so a lock can save what there is of it. */
        this.activeReply = null;
        /** @type {AbortController|null} an MDN lookup Stop can cancel */
        this.lookupAbort = null;
        /** Memory profile: model, context window, reply limit and prompt budget. Fixed for the page's lifetime. */
        this.profile = profile;
        /** @type {import('./webllmConfig.js').WebLLMModel} the model the profile runs */
        this.model = getWebLLMModel(profile.model);
        /** Reply limits and step counts for the profile's sequential thinking. */
        this.thinking = WEBLLM_THINKING[profile.id] || WEBLLM_THINKING.desktop;
        /** Set by Stop; a thinking reply checks it between its steps. */
        this.stopRequested = false;
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
     * and only that wallet's saved conversations are opened. Its Nostr address
     * is kept as the author of the projects' commits; it may arrive after the
     * wallet does, so it is taken on every call.
     * @param {boolean} allowed
     * @param {{ walletAddress?: string|null, npub?: string|null }} [identity]
     */
    setAllowed(allowed, { walletAddress = null, npub = null } = {}) {
        const wallet = walletAddress ? `${walletAddress}`.toLowerCase() : null;
        this.npub = allowed && npub ? `${npub}` : null;
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
            void this.loadThoughts(wallet, epoch);
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

    /**
     * Open this wallet's thought store, best-effort: without it, thinking
     * replies still work, recalling only what the reply itself wrote.
     * @param {string} wallet
     * @param {number} epoch
     */
    async loadThoughts(wallet, epoch) {
        if (!this.openThoughts) return;
        try {
            const thoughts = await this.openThoughts(wallet);
            if (epoch !== this.epoch) {
                thoughts.close();
                return;
            }
            this.thoughts = thoughts;
            // Thoughts of conversations deleted or expired while away go too.
            await thoughts.purge({ keepConversationIds: this.conversationsInUse(this.state.conversations) });
        } catch (error) {
            this.log(`WebLLM thought store unavailable: ${error?.message || error}`);
        }
    }

    /**
     * Conversations whose thoughts must stay: the listed ones, the open one,
     * and the one a reply is being written in.
     * @param {{ id: string }[]} listed
     */
    conversationsInUse(listed) {
        const ids = new Set(listed.map((entry) => entry.id));
        if (this.state.activeConversationId) ids.add(this.state.activeConversationId);
        if (this.activeReply?.conversationId) ids.add(this.activeReply.conversationId);
        return ids;
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
            // An expired conversation takes its thoughts with it — never the
            // one being written to, which this list may predate.
            await this.thoughts?.purge({ keepConversationIds: this.conversationsInUse(conversations) });
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
        // Its thoughts go too, best-effort: the conversation is gone either way.
        void this.thoughts?.deleteConversation(conversationId)?.catch?.(() => {});
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

    /**
     * Keep where the engine runs, so the next load goes straight there. Only a
     * worker that answered without a GPU makes it the page for good.
     * @param {any} engine
     */
    rememberEngine(engine) {
        const kind = engine?.workerHasNoGpu ? 'page' : engine?.kind === 'worker' ? 'worker' : null;
        if (!kind || kind === this.state.settings.engine) return;
        this.update({ settings: { ...this.state.settings, engine: kind } });
        void this.history?.setSetting('engine', kind).catch((error) => {
            this.log(`WebLLM engine choice could not be saved: ${error?.message || error}`);
        });
    }

    /**
     * How replies are written: 'short', 'thinking', or 'auto' (the model chooses).
     * @param {string} mode one of WEBLLM_REPLY_MODES
     */
    async setReplyMode(mode) {
        if (!WEBLLM_REPLY_MODES.includes(mode)) return;
        this.update({ settings: { ...this.state.settings, replyMode: mode } });
        try {
            await this.history?.setSetting('replyMode', mode);
        } catch (error) {
            this.log(`WebLLM reply mode could not be saved: ${error?.message || error}`);
        }
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
                    error: { ...classifyError({ name: gpuErrorName(gpu), message: gpu.reason || '' }, this.model) }
                });
                return;
            }

            // On a phone, a Llama downloaded before goes first: SmolLM2 takes
            // its place, and the space it frees is what the storage check sees.
            await this.removeReplacedModels();
            if (epoch !== this.epoch) return;

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
                this.update({ status: 'error', error: classifyError(error, this.model) });
            })
            .finally(() => {
                // Only this session's check: a lock may have started another.
                if (epoch === this.epoch) this.checking = null;
            });
        return this.checking;
    }

    /**
     * Delete the builds the profile's model replaces, without asking: on a
     * phone, any Llama 3.2 1B a browser still holds. A desktop replaces
     * nothing. What was found and removed is kept in `state.replaced`, for the
     * install screen to say. Best-effort: a failure only means the space is not
     * freed.
     */
    async removeReplacedModels() {
        if (!this.model.replaces.length || typeof this.swClient.clearReplacedModels !== 'function') return;
        try {
            const results = await this.swClient.clearReplacedModels();
            const removed = (results || []).filter((entry) => entry.removed > 0);
            if (removed.length === 0) return;
            this.log(
                `Removed ${removed.map((entry) => entry.modelId).join(', ')} to make room for ${this.model.modelId}.`
            );
            this.update({ replaced: [...new Set(removed.map((entry) => entry.label))] });
        } catch (error) {
            this.log(`Older models could not be removed: ${error?.message || error}`);
        }
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
                    error: classifyError({ name: gpuErrorName(gpu), message: gpu.reason || '' }, this.model)
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

                // Where the engine ran before decides where it runs now: the
                // worker is not retried once it said it only had the CPU.
                const engine = await this.createEngine({ preferred: this.state.settings.engine ?? null });
                if (stale()) {
                    engine.dispose();
                    return;
                }
                this.engine = engine;
                this.update({ engineKind: engine.kind || null });
                this.rememberEngine(engine);

                await engine.load((report) => {
                    if (stale()) return;
                    this.update({ progress: parseInitProgress(report) }, { type: 'progress' });
                }, this.profile);
                this.log(
                    `Loaded ${this.model.modelId} with the ${this.profile.id} profile: ` +
                        `${this.profile.contextWindow}-token context, ` +
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
            const classified = classifyError(error, this.model);
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
        const needed = Math.max(0, this.model.downloadBytes - already);
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
     * Nothing is asked once Stop was pressed. Stop interrupts the engine, but
     * an interrupt sent while nothing was generating — during a lookup, a
     * recall or a save between two requests — has nothing to stop, so every
     * request checks for it first and ends as stopped instead.
     *
     * @param {any} engine
     * @param {ChatMessage[]} prior
     * @param {string} content
     * @param {(delta: string) => void} onDelta
     * @param {() => boolean} stale
     * @param {string[]} systems system prompts to try, richest first
     * @param {{ maxTokens?: number|null, schema?: object|null }} [options] a shorter reply limit for this
     *   request, and a JSON schema the reply must follow
     * @returns {Promise<{ result: any, system: string }>}
     */
    async generate(
        engine,
        prior,
        content,
        onDelta,
        stale,
        systems = [WEBLLM_SYSTEM_PROMPT],
        { maxTokens = null, schema = null } = {}
    ) {
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
            if (this.stopRequested) return { result: { finishReason: 'abort' }, system };
            try {
                const result =
                    maxTokens || schema
                        ? await engine.chat(sent, onDelta, {
                              ...(maxTokens ? { maxTokens } : {}),
                              ...(schema ? { schema } : {})
                          })
                        : await engine.chat(sent, onDelta);
                return { result, system };
            } catch (error) {
                if (stale() || classifyError(error, this.model).kind !== 'context') throw error;
                lastError = error;
            }
        }
        throw lastError || Object.assign(new Error(MESSAGE_TOO_LONG), { name: 'MessageTooLong' });
    }

    /**
     * Record how a reply ended.
     * @param {ChatMessage} reply
     * @param {{ finishReason?: string|null, usage?: any }|undefined} result
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
     * A thinking reply looks each step up on its own: `query` is then the
     * step, `context` the task it belongs to (which decides whether it is a
     * development question at all), and `share` the part of the budget one
     * step's documentation may take, since the step's prompt carries more.
     *
     * @param {string} content
     * @param {ChatMessage} reply
     * @param {() => boolean} stale
     * @param {{ query?: string, system?: string, share?: number }} [options]
     * @returns {Promise<import('./mdnLookup.js').MdnLookup|null>}
     */
    async lookupDocumentation(
        content,
        reply,
        stale,
        { query = content, system = WEBLLM_SYSTEM_PROMPT, share = 1 } = {}
    ) {
        if (!this.mdnClient || !this.state.settings.mdnEnabled || this.stopRequested) return null;
        if (!isDevelopmentQuestion(query) && !isDevelopmentQuestion(content)) return null;
        // Leave the documentation no more than the budget can spare after the
        // system prompt and the question itself.
        const room =
            this.profile.promptTokenBudget -
            estimateTokens(system) -
            estimateTokens(content) -
            4 * WEBLLM_MESSAGE_FRAMING_TOKENS -
            96;
        const cap = MDN_CONTEXT_TOKENS[this.profile.id] ?? MDN_CONTEXT_TOKENS.desktop;
        const maxTokens = Math.min(Math.floor(cap * share), room);
        if (maxTokens < 80) return null;

        this.lookupAbort = new AbortController();
        this.update({ lookup: 'searching' });
        try {
            return await lookupMdn(this.mdnClient, query, { maxTokens, signal: this.lookupAbort.signal });
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

        this.stopRequested = false;
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
            // First, how to write it: the setting, or the model's own choice.
            const { mode, auto } = await this.chooseMode(engine, prior, content, stale);
            if (stale()) return false;
            /** @type {any} */
            let result = { finishReason: 'abort' };
            // Stopped before a word was written: no mode to show for it.
            if (!this.stopRequested) {
                reply.mode = mode;
                reply.autoMode = auto;
                result =
                    mode === 'thinking'
                        ? await this.writeThinking(engine, prior, content, reply, stale, conversationId)
                        : await this.writeShort(engine, prior, content, reply, stale);
            }
            if (stale() || !result) return false;
            this.finishReply(reply, result);
        } catch (error) {
            if (stale()) return false;
            const classified = classifyError(error, this.model);
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
                this.update({ generating: false, thinking: null }, { type: 'messages' });
            }
        }
        return true;
    }

    /** @param {ReturnType<typeof initialState>['thinking']} thinking */
    setThinking(thinking) {
        this.update({ thinking });
    }

    /**
     * Append text to the reply being written and redraw it.
     * @param {ChatMessage} reply
     * @param {() => boolean} stale
     */
    appender(reply, stale) {
        return (/** @type {string} */ delta) => {
            if (stale()) return;
            reply.content += delta;
            this.onChange(this.state, { type: 'delta', messageId: reply.id });
        };
    }

    /**
     * The reply mode for this message. Short and Thinking are the user's
     * choice; on Auto, the model answers {"mode": …} in a few tokens — on the GPU,
     * constrained to a JSON schema — and anything else is taken as Short.
     *
     * @param {any} engine
     * @param {ChatMessage[]} prior
     * @param {string} content
     * @param {() => boolean} stale
     * @returns {Promise<{ mode: import('./webllmThinking.js').ReplyMode, auto: boolean }>}
     */
    async chooseMode(engine, prior, content, stale) {
        const setting = this.state.settings.replyMode;
        if (setting === 'short' || setting === 'thinking') return { mode: setting, auto: false };
        this.setThinking({ mode: 'auto', phase: 'deciding', step: 0, total: 0 });
        let answer = '';
        try {
            await this.generate(
                engine,
                prior,
                content,
                (delta) => {
                    answer += delta;
                },
                stale,
                [MODE_SYSTEM_PROMPT],
                { maxTokens: this.thinking.decideMaxTokens, schema: MODE_SCHEMA }
            );
        } catch (error) {
            if (stale()) throw error;
            this.log(`WebLLM could not choose a reply mode: ${error?.message || error}`);
        }
        const mode = parseModeDecision(answer) || 'short';
        if (!this.stopRequested) this.log(`Reply mode (auto): ${mode}.`);
        return { mode, auto: true };
    }

    /**
     * A short answer: one lookup for the facts, one reply in a small window.
     *
     * @param {any} engine
     * @param {ChatMessage[]} prior
     * @param {string} content
     * @param {ChatMessage} reply
     * @param {() => boolean} stale
     * @returns {Promise<any>} how the reply ended; null once stale
     */
    /**
     * The project files the user saved from the canvas that look most like
     * `query`, recalled from the thought store (idb-vector). A Thinking reply
     * recalls them with every other thought; a short one gets only these.
     * @param {string} query
     * @returns {Promise<string>} '' when there are none
     */
    async recallProjectFiles(query) {
        const conversationId = this.state.activeConversationId;
        if (!this.thoughts || !conversationId) return '';
        try {
            const isFile = (/** @type {any} */ thought) =>
                `${thought?.clientRequestId || ''}`.startsWith('project-file:');
            const recalled = await this.thoughts.recall({
                query,
                conversationId,
                limit: Math.min(2, this.thinking.recallLimit),
                minSimilarity: this.thinking.recallMinSimilarity,
                filter: isFile
            });
            const files = (Array.isArray(recalled) ? recalled : []).filter(isFile);
            return formatRecall(
                files.map((file) => ({ label: 'Project file', text: file.thought })),
                this.thinking.recallTokens
            );
        } catch (error) {
            this.log(`WebLLM project files could not be recalled: ${error?.message || error}`);
            return '';
        }
    }

    async writeShort(engine, prior, content, reply, stale) {
        this.setThinking({ mode: 'short', phase: 'lookup', step: 0, total: 0 });
        const files = await this.recallProjectFiles(content);
        if (stale()) return null;
        // With the files when they fit, without them when they do not.
        const base = files
            ? `${SHORT_SYSTEM_PROMPT}\n\nThe user's project, as saved in the canvas:\n${files}`
            : SHORT_SYSTEM_PROMPT;
        const lookup = await this.lookupDocumentation(content, reply, stale, { system: base });
        if (stale()) return null;
        // Stop during the lookup: nothing was generated.
        if (reply.stopped || this.stopRequested) return { finishReason: 'abort' };
        this.setThinking({ mode: 'short', phase: 'writing', step: 0, total: 0 });
        const withDocs = buildSystemPrompt(base, lookup);
        const { result, system } = await this.generate(
            engine,
            prior,
            content,
            this.appender(reply, stale),
            stale,
            [...new Set(lookup ? [withDocs, base, SHORT_SYSTEM_PROMPT] : [base, SHORT_SYSTEM_PROMPT])],
            { maxTokens: this.thinking.shortMaxTokens }
        );
        if (stale()) return null;
        // Documentation is credited only if it was actually in the prompt.
        if (lookup && system === withDocs) {
            reply.sources = lookup.sources;
            reply.docContext = lookup.context;
        }
        return result;
    }

    /**
     * Keep a thought, best-effort: a reply never fails because the store did.
     * @param {import('./webllmThoughtStore.js').AppendThoughtCommand} command
     */
    async think(command) {
        if (!this.thoughts) return null;
        const result = await this.thoughts.appendThought(command);
        if (!result.ok) {
            this.log(`WebLLM thought not kept (${result.error.code}): ${result.error.message}`);
            return null;
        }
        return result.value;
    }

    /**
     * What a step is shown of the earlier thinking: always the latest
     * completed step, then the thoughts of this conversation most like the
     * step — this reply's and earlier answers' — above the similarity floor,
     * without duplicates, in the order they were thought. Steps that did not
     * finish are never recalled as earlier work. Without a thought store: the
     * end of what this reply's completed steps wrote.
     *
     * @param {{ step: string, task: string, conversationId: string|null, sequenceId: string|null,
     *           planThoughtId: string|null, written: string,
     *           pinned?: { id: string|null, number: number, text: string }|null }} options
     *   `written` is the completed steps' text; `pinned` the latest completed step
     */
    async recallFor({ step, task, conversationId, sequenceId, planThoughtId, written, pinned = null }) {
        const budget = this.thinking.recallTokens;
        if (this.thoughts && conversationId) {
            try {
                const thoughts = await this.thoughts.recall({
                    query: `${step}\n${task}`,
                    conversationId,
                    sequenceId,
                    limit: this.thinking.recallLimit,
                    minSimilarity: this.thinking.recallMinSimilarity,
                    pinned: pinned?.id ? [pinned.id] : [],
                    // The plan is in the step's prompt already.
                    exclude: new Set(planThoughtId ? [planThoughtId] : [])
                });
                const entries = thoughts.map((thought) => ({
                    label:
                        thought.sequenceId === sequenceId
                            ? `Thought ${thought.thoughtNumber}`
                            : 'From an earlier answer in this conversation',
                    text: thought.thought,
                    // The step just before gets the larger share of the budget.
                    weight: pinned?.id && thought.id === pinned.id ? 2 : 1
                }));
                // Kept from this reply even if the store did not keep it.
                if (pinned && !thoughts.some((thought) => thought.id === pinned.id)) {
                    entries.push({ label: `Thought ${pinned.number}`, text: pinned.text, weight: 2 });
                }
                return formatRecall(entries, budget);
            } catch (error) {
                this.log(`WebLLM thoughts could not be recalled: ${error?.message || error}`);
            }
        }
        return formatRecall(written.trim() ? [{ label: 'Earlier steps', text: written }] : [], budget);
    }

    /**
     * The one continuation a step cut at its token limit may get: the step's
     * own request, with what it wrote so far as the start of the answer, if
     * that still fits the context window. Streams into the reply like the
     * step did. Null when there is no room, no text yet, or it failed — the
     * step then stays truncated, and is marked so.
     *
     * @param {any} engine
     * @param {{ prior: ChatMessage[], message: string, system: string, partial: string,
     *           append: (delta: string) => void, stale: () => boolean }} options
     */
    async continueStep(engine, { prior, message, system, partial, append, stale }) {
        if (typeof engine?.continue !== 'function' || !partial.trim() || this.stopRequested) return null;
        const budget = this.profile.promptTokenBudget - estimateTokens(partial) - WEBLLM_MESSAGE_FRAMING_TOKENS;
        const plan = this.planPrompt(prior, message, budget, system);
        if (!plan.fits) return null;
        try {
            return await engine.continue(plan.messages, partial, append, {
                maxTokens: this.thinking.stepContinueTokens
            });
        } catch (error) {
            if (!stale()) this.log(`WebLLM step continuation failed: ${classifyError(error, this.model).detail}`);
            return null;
        }
    }

    /**
     * A thinking answer, as a sequence of thoughts: the plan (thought 1, a
     * JSON schema answer), then each step (thoughts 2…N+1) in its own request
     * with its own MDN lookup and the earlier thoughts recalled for it. Every
     * thought is kept in the thought store. Without a usable plan the task is
     * written in one go.
     *
     * @param {any} engine
     * @param {ChatMessage[]} prior
     * @param {string} content
     * @param {ChatMessage} reply
     * @param {() => boolean} stale
     * @param {string|null} conversationId
     * @returns {Promise<any>} how the last step ended; null once stale
     */
    async writeThinking(engine, prior, content, reply, stale, conversationId) {
        const limits = this.thinking;
        this.setThinking({ mode: 'thinking', phase: 'planning', step: 0, total: 0 });
        let planText = '';
        const planSystem = `${WEBLLM_SYSTEM_PROMPT}\n\n${planInstruction(limits.maxSteps)}`;
        const planned = await this.generate(
            engine,
            prior,
            content,
            (delta) => {
                planText += delta;
            },
            stale,
            [planSystem],
            { maxTokens: limits.planMaxTokens, schema: PLAN_SCHEMA }
        );
        if (stale()) return null;
        if (this.stopRequested || planned.result?.finishReason === 'abort') return { finishReason: 'abort' };

        const plan = parsePlan(planText, limits.maxSteps);
        const steps = plan.length > 0 ? plan : [content];
        const total = steps.length;
        reply.steps = plan.length;
        const append = this.appender(reply, stale);
        if (plan.length > 0) append(formatPlan(plan));

        // Thought 1: the plan.
        const first = conversationId
            ? await this.think({
                  conversationId,
                  messageId: reply.id,
                  sequenceTitle: content,
                  thought: plan.length > 0 ? formatPlan(plan) : `Write the whole task in one step: ${content}`,
                  thoughtNumber: 1,
                  totalThoughts: total + 1,
                  nextThoughtNeeded: true,
                  clientRequestId: `${reply.id}:1`
              })
            : null;
        if (stale()) return null;
        const sequenceId = first?.sequenceId ?? null;
        reply.sequenceId = sequenceId;
        if (this.stopRequested) return { finishReason: 'abort' };

        /** @type {any} */
        let last = { finishReason: 'stop' };
        /** @type {{ title: string, url: string }[]} */
        const sources = [];
        /** Zero-based steps that did not finish; they are not built on. @type {number[]} */
        const incomplete = [];
        /** The completed steps as written, for recall without a thought store. @type {string[]} */
        const confirmed = [];
        /** The latest completed step, always shown to the next. */
        let pinned = /** @type {{ id: string|null, number: number, text: string }|null} */ (null);
        for (let index = 0; index < total; index += 1) {
            // Stop while the previous step was being saved.
            if (this.stopRequested) return { finishReason: 'abort' };

            this.setThinking({ mode: 'thinking', phase: 'lookup', step: index + 1, total });
            const base = `${WEBLLM_SYSTEM_PROMPT}\n\n${stepInstruction(index, total)}`;
            // Each step is looked up on its own: its documentation is not carried to the next.
            const lookup = await this.lookupDocumentation(content, reply, stale, {
                query: plan.length > 0 ? steps[index] : content,
                system: base,
                share: plan.length > 0 ? limits.stepDocShare : 1
            });
            if (stale()) return null;
            if (this.stopRequested) return { finishReason: 'abort' };

            this.setThinking({ mode: 'thinking', phase: 'recall', step: index + 1, total });
            const recalled =
                plan.length > 0
                    ? await this.recallFor({
                          step: steps[index],
                          task: content,
                          conversationId,
                          sequenceId,
                          planThoughtId: first?.thought.id ?? null,
                          written: confirmed.join('\n\n'),
                          pinned
                      })
                    : '';
            if (stale()) return null;
            // Stop during the recall: the interrupt it sent had no generation to stop.
            if (this.stopRequested) return { finishReason: 'abort' };

            // The heading goes in only now, so a step stopped before it was
            // written leaves no empty heading behind.
            if (plan.length > 0) append(`\n\n${stepHeading(index, total, steps[index])}\n\n`);
            this.setThinking({ mode: 'thinking', phase: 'writing', step: index + 1, total });
            const withDocs = buildSystemPrompt(base, lookup);
            const message = stepMessage({ task: content, steps, index, recalled, incomplete });
            // The step's own text starts after its heading.
            const start = reply.content.length;
            const generated = await this.generate(
                engine,
                prior,
                message,
                append,
                stale,
                lookup ? [withDocs, base] : [base],
                { maxTokens: limits.stepMaxTokens }
            );
            if (stale()) return null;
            const { system } = generated;
            if (lookup && system === withDocs) {
                for (const source of lookup.sources) {
                    if (!sources.some((entry) => entry.url === source.url)) sources.push(source);
                }
                reply.sources = [...sources];
            }

            // Cut at the step's token limit: one continuation, in place, if it fits.
            let result = generated.result;
            if (result?.finishReason === 'length') {
                const more = await this.continueStep(engine, {
                    prior,
                    message,
                    system,
                    partial: reply.content.slice(start),
                    append,
                    stale
                });
                if (stale()) return null;
                if (more) result = more;
            }

            const stopped = result?.finishReason === 'abort' || this.stopRequested;
            // Judged on the text as the model wrote it, before any fence is
            // closed for the screen: a closed fence is not finished code.
            const status = stepStatus(result?.finishReason, reply.content.slice(start), { stopped });
            const done = stepConfirmed(status);

            // A step that ended inside a code block closes it, so the next
            // step's heading and snippets are not drawn inside it.
            const stepText = reply.content.slice(start);
            const closed = closeOpenFence(stepText);
            if (closed !== stepText) {
                reply.content = reply.content.slice(0, start) + closed;
                this.onChange(this.state, { type: 'delta', messageId: reply.id });
            }
            const text = reply.content.slice(start).trim();
            const isLast = index === total - 1;
            if (!done && !stopped) {
                incomplete.push(index);
                // Said in the reply itself. Not for a last step cut at the
                // limit: Continue picks that one up where it stopped.
                if (!(status === 'truncated' && isLast)) append(incompleteStepMarker(status, index, total));
            }

            // Thought index+2: this step, as written — marked when it did not finish.
            const thoughtText = plan.length > 0 ? `${steps[index]}\n\n${text}` : text;
            if (sequenceId && text) {
                const saved = await this.think({
                    sequenceId,
                    thought: thoughtText,
                    thoughtNumber: index + 2,
                    totalThoughts: total + 1,
                    nextThoughtNeeded: !stopped && index < total - 1,
                    clientRequestId: `${reply.id}:${index + 2}`,
                    ...(done ? {} : { incomplete: true })
                });
                if (stale()) return null;
                if (done) pinned = { id: saved?.thought.id ?? null, number: index + 2, text: thoughtText };
            } else if (done && text) {
                pinned = { id: null, number: index + 2, text: thoughtText };
            }
            if (done && text) {
                confirmed.push(plan.length > 0 ? `${stepHeading(index, total, steps[index])}\n\n${text}` : text);
            }
            if (stopped) return { ...result, finishReason: 'abort' };
            last = result;
        }
        const marked = incomplete.filter((index) => !(index === total - 1 && last?.finishReason === 'length'));
        if (marked.length > 0) reply.notice = stepIncompleteNotice(marked.map((index) => index + 1));
        return last;
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
        this.stopRequested = false;
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
            const classified = classifyError(error, this.model);
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
        this.stopRequested = true;
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
        this.thoughts?.close();
        this.thoughts = null;
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

/**
 * A saved reply's mode; the first names of the two modes are read too.
 * @returns {import('./webllmThinking.js').ReplyMode|null}
 */
function replyModeOf(value) {
    if (value === 'short' || value === 'informative') return 'short';
    if (value === 'thinking' || value === 'productive') return 'thinking';
    return null;
}

/** A CPU-emulated adapter is told apart from no WebGPU at all: the fix differs. */
function gpuErrorName(gpu) {
    return gpu?.fallbackAdapter ? 'WebGPUFallbackAdapterError' : 'WebGPUNotAvailableError';
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
        mode: replyModeOf(row.mode),
        autoMode: Boolean(row.autoMode),
        steps: Number.isInteger(row.steps) ? row.steps : 0,
        sequenceId: row.sequenceId || null,
        createdAt: row.createdAt
    };
}
