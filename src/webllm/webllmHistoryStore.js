// @ts-check
/**
 * Saved WebLLM conversations, in this browser's IndexedDB.
 *
 * Each wallet gets its own database, named after a hash of its address, so one
 * wallet's session never opens — or even names — another's history. (This
 * separates wallets inside WEB25; it is not encryption: the browser profile
 * still holds the data, as it holds every site's IndexedDB.)
 *
 *   conversations  { id, title, createdAt, updatedAt }
 *   messages       { id, conversationId, seq, role, content, finishReason, notice,
 *                    stopped, error, sources, docContext, lookupNote, createdAt }
 *   meta           { key, value }  — retention and the MDN lookup preference
 *
 * Retention is counted from a conversation's last activity. Expired
 * conversations are deleted when the history is opened and whenever the list
 * is read, so they are never shown.
 *
 * Nothing here touches WebLLM's model caches: deleting history never deletes
 * the downloaded model.
 */

import { WEBLLM_DEFAULT_RETENTION, WEBLLM_RETENTION_OPTIONS } from './webllmConfig.js';

export const WEBLLM_HISTORY_DB_PREFIX = 'web25-webllm-history-';
const DB_VERSION = 1;

/** Titles are a short reading of the first question, not the question itself. */
const TITLE_MAX_CHARS = 48;

/**
 * A conversation title from the first message: its first line, trimmed of
 * code and markup, cut at a word.
 * @param {string} text
 */
export function conversationTitle(text) {
    const line =
        `${text || ''}`
            .replace(/```[\s\S]*?(```|$)/g, ' ')
            .replace(/[`*_#>]/g, '')
            .split('\n')
            .map((part) => part.trim())
            .find(Boolean) || '';
    const clean = line.replace(/\s+/g, ' ').trim();
    if (!clean) return 'New chat';
    if (clean.length <= TITLE_MAX_CHARS) return clean;
    const cut = clean.slice(0, TITLE_MAX_CHARS);
    const space = cut.lastIndexOf(' ');
    return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

/**
 * The database name for a wallet: a hash, so the address itself is never
 * written into a database name.
 * @param {string} walletAddress
 */
export async function historyDatabaseName(walletAddress) {
    const normalized = `${walletAddress || ''}`.trim().toLowerCase();
    if (!normalized) throw new Error('A wallet address is required to open chat history.');
    const bytes = new TextEncoder().encode(`web25-webllm-history:${normalized}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return (
        WEBLLM_HISTORY_DB_PREFIX + [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    );
}

/** @param {string} id */
export function retentionMs(id) {
    const option = WEBLLM_RETENTION_OPTIONS.find((entry) => entry.id === id);
    return option ? option.ms : retentionMs(WEBLLM_DEFAULT_RETENTION);
}

const isRetention = (value) => WEBLLM_RETENTION_OPTIONS.some((entry) => entry.id === value);

/** @param {IDBRequest} request */
function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function randomId() {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The fields of a chat message worth keeping. */
function storedMessage(conversationId, seq, message, now) {
    return {
        id: message.id,
        conversationId,
        seq,
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: `${message.content || ''}`,
        finishReason: message.finishReason || null,
        notice: message.notice || null,
        stopped: Boolean(message.stopped),
        error: message.error || null,
        sources: Array.isArray(message.sources) ? message.sources.map(({ title, url }) => ({ title, url })) : [],
        docContext: message.docContext || null,
        lookupNote: message.lookupNote || null,
        createdAt: message.createdAt || now
    };
}

export class WebLLMHistoryStore {
    /**
     * @param {IDBDatabase} db
     * @param {() => number} now
     */
    constructor(db, now) {
        this.db = db;
        this.now = now;
        /** @type {Map<string, number>} next message position per conversation */
        this.seq = new Map();
    }

    /**
     * Run one transaction to completion.
     * @template T
     * @param {string[]} stores
     * @param {'readonly'|'readwrite'} mode
     * @param {(tx: IDBTransaction) => Promise<T>} work
     * @returns {Promise<T>}
     */
    async run(stores, mode, work) {
        const tx = this.db.transaction(stores, mode);
        const done = new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(undefined);
            tx.onabort = () => reject(tx.error || new Error('Chat history could not be saved.'));
            tx.onerror = () => reject(tx.error || new Error('Chat history could not be saved.'));
        });
        const result = await work(tx);
        await done;
        return result;
    }

    async getSettings() {
        const rows = await this.run(['meta'], 'readonly', (tx) => promisify(tx.objectStore('meta').getAll()));
        const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
        return {
            retention: isRetention(values.retention) ? values.retention : WEBLLM_DEFAULT_RETENTION,
            mdnEnabled: values.mdnEnabled !== false
        };
    }

    /**
     * @param {'retention'|'mdnEnabled'} key
     * @param {any} value
     */
    async setSetting(key, value) {
        if (key === 'retention' && !isRetention(value)) throw new Error(`Unknown retention: ${value}`);
        if (key === 'mdnEnabled') value = Boolean(value);
        await this.run(['meta'], 'readwrite', (tx) => promisify(tx.objectStore('meta').put({ key, value })));
        if (key === 'retention') await this.purgeExpired();
    }

    /** Delete every conversation whose last activity is older than the retention period. */
    async purgeExpired() {
        const { retention } = await this.getSettings();
        const keep = retentionMs(retention);
        if (keep === null) return 0;
        const cutoff = this.now() - keep;
        const all = await this.run(['conversations'], 'readonly', (tx) =>
            promisify(tx.objectStore('conversations').getAll())
        );
        const expired = all.filter((conversation) => conversation.updatedAt < cutoff);
        for (const conversation of expired) await this.deleteConversation(conversation.id);
        return expired.length;
    }

    /** Saved conversations, most recent activity first. Expired ones are removed first. */
    async listConversations() {
        await this.purgeExpired();
        const all = await this.run(['conversations'], 'readonly', (tx) =>
            promisify(tx.objectStore('conversations').getAll())
        );
        return all.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /** @param {string} title */
    async createConversation(title) {
        const now = this.now();
        const conversation = { id: randomId(), title: conversationTitle(title), createdAt: now, updatedAt: now };
        await this.run(['conversations'], 'readwrite', (tx) =>
            promisify(tx.objectStore('conversations').put(conversation))
        );
        this.seq.set(conversation.id, 0);
        return conversation;
    }

    /** @param {string} conversationId */
    async getMessages(conversationId) {
        const rows = await this.run(['messages'], 'readonly', (tx) =>
            promisify(tx.objectStore('messages').index('byConversation').getAll(conversationId))
        );
        rows.sort((a, b) => a.seq - b.seq);
        this.seq.set(conversationId, rows.length ? rows[rows.length - 1].seq + 1 : 0);
        return rows;
    }

    /**
     * Save a message (new or updated) and mark the conversation active now.
     * @param {string} conversationId
     * @param {any} message
     */
    async saveMessage(conversationId, message) {
        const now = this.now();
        await this.run(['conversations', 'messages'], 'readwrite', async (tx) => {
            const messages = tx.objectStore('messages');
            const existing = await promisify(messages.get(message.id));
            let seq = existing?.seq;
            if (seq === undefined) {
                seq = this.seq.get(conversationId) ?? 0;
                this.seq.set(conversationId, seq + 1);
            }
            const conversations = tx.objectStore('conversations');
            const conversation = await promisify(conversations.get(conversationId));
            if (!conversation) throw new Error('That conversation no longer exists.');
            await promisify(messages.put(storedMessage(conversationId, seq, message, existing?.createdAt || now)));
            await promisify(conversations.put({ ...conversation, updatedAt: now }));
        });
    }

    /** Delete one conversation and its messages. Model files are not involved. */
    async deleteConversation(conversationId) {
        await this.run(['conversations', 'messages'], 'readwrite', async (tx) => {
            const messages = tx.objectStore('messages');
            const rows = await promisify(messages.index('byConversation').getAll(conversationId));
            for (const row of rows) messages.delete(row.id);
            await promisify(tx.objectStore('conversations').delete(conversationId));
        });
        this.seq.delete(conversationId);
    }

    close() {
        this.db.close();
    }
}

/**
 * Open the history of one wallet.
 *
 * @param {{ walletAddress: string, indexedDB?: IDBFactory, now?: () => number }} options
 */
export async function openWebLLMHistory({ walletAddress, indexedDB = globalThis.indexedDB, now = () => Date.now() }) {
    if (!indexedDB) throw new Error('IndexedDB is not available in this browser.');
    const name = await historyDatabaseName(walletAddress);
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const database = /** @type {any} */ (event.target).result;
            if (!database.objectStoreNames.contains('conversations')) {
                database.createObjectStore('conversations', { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains('messages')) {
                database
                    .createObjectStore('messages', { keyPath: 'id' })
                    .createIndex('byConversation', 'conversationId');
            }
            if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const store = new WebLLMHistoryStore(db, now);
    await store.purgeExpired();
    return store;
}
