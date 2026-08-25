// @ts-check
/**
 * Browser-side Nostr relay pool.
 *
 * Opens plain WebSockets from the page to a configurable set of public
 * relays. There is no proxy and no Web25-operated relay: this class is the
 * whole networking layer.
 *
 * Design rules, all of which the tests pin:
 *   - a relay is never an authority. Every inbound event is re-verified
 *     locally (shape, id binding, BIP-340 signature) and re-matched against
 *     the filter the subscription actually asked for.
 *   - no single relay is required. Connections are attempted in parallel,
 *     failures are recorded and ignored, and one reachable relay is enough.
 *   - events are deduplicated by id, so the same gift wrap arriving from four
 *     relays is delivered to the application exactly once.
 *   - subscriptions and sockets are always cleaned up, including on close.
 */

import { DEFAULT_NOSTR_RELAYS, NOSTR_CONFIG } from '../config/nostr.config.js';

const WS_OPEN = 1;

/**
 * Local re-check that an event actually satisfies a filter. Relays are free
 * to send anything; only events that match what we asked for are delivered.
 *
 * @param {any} event
 * @param {Record<string, any>} filter
 * @returns {boolean}
 */
export function eventMatchesFilter(event, filter) {
    if (!filter || typeof filter !== 'object') return false;
    if (Array.isArray(filter.ids) && !filter.ids.includes(event.id)) return false;
    if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
    if (Array.isArray(filter.authors) && !filter.authors.includes(event.pubkey)) return false;
    if (typeof filter.since === 'number' && event.created_at < filter.since) return false;
    if (typeof filter.until === 'number' && event.created_at > filter.until) return false;

    for (const [key, wanted] of Object.entries(filter)) {
        if (!key.startsWith('#') || !Array.isArray(wanted)) continue;
        const tagName = key.slice(1);
        const present = event.tags.some((tag) => tag[0] === tagName && wanted.includes(tag[1]));
        if (!present) return false;
    }
    return true;
}

export class NostrRelayPool {
    /**
     * @param {{
     *   relays?: string[],
     *   verifyEvent: (event: any) => boolean,
     *   WebSocketImpl?: any,
     *   now?: () => number,
     *   config?: typeof NOSTR_CONFIG
     * }} options
     */
    constructor({ relays = DEFAULT_NOSTR_RELAYS, verifyEvent, WebSocketImpl = null, now = Date.now, config = NOSTR_CONFIG }) {
        if (typeof verifyEvent !== 'function') throw new Error('NostrRelayPool requires an event verifier.');

        this.config = config;
        this.verifyEvent = verifyEvent;
        this.now = now;
        this.WebSocketImpl = WebSocketImpl || (typeof WebSocket === 'function' ? WebSocket : null);
        this.relayUrls = normalizeRelayUrls(relays);
        if (this.relayUrls.length === 0) throw new Error('At least one Nostr relay URL is required.');

        /** @type {Map<string, { url: string, socket: any, status: string, lastError: string|null, reconnectDelay: number, timer: any }>} */
        this.relays = new Map();
        /** @type {Map<string, { id: string, filters: any[], onEvent: Function, onEose: Function|null, seen: Set<string>, closed: boolean }>} */
        this.subscriptions = new Map();
        /** @type {Map<string, { resolve: Function, accepted: Set<string>, rejected: Map<string,string>, timer: any }>} */
        this.pendingPublishes = new Map();
        this.closed = false;
        this.counter = 0;
    }

    /** Snapshot of per-relay connection state, for the UI and tests. */
    get status() {
        return this.relayUrls.map((url) => {
            const relay = this.relays.get(url);
            return { url, status: relay?.status || 'idle', lastError: relay?.lastError || null };
        });
    }

    get connectedCount() {
        let count = 0;
        for (const relay of this.relays.values()) {
            if (relay.status === 'connected') count += 1;
        }
        return count;
    }

    /**
     * Open every relay socket. Never rejects: an unreachable relay is recorded
     * and the pool keeps working with whatever else came up.
     * @returns {Promise<{ connected: number, total: number }>}
     */
    async connect() {
        if (this.closed) throw new Error('This relay pool has been closed.');
        if (!this.WebSocketImpl) throw new Error('WebSockets are not available in this environment.');
        await Promise.all(this.relayUrls.map((url) => this._openRelay(url)));
        return { connected: this.connectedCount, total: this.relayUrls.length };
    }

    /**
     * @param {string} url
     * @returns {Promise<void>} resolves once the socket is open or has failed.
     */
    _openRelay(url) {
        const existing = this.relays.get(url);
        if (existing && (existing.status === 'connected' || existing.status === 'connecting')) return Promise.resolve();

        const entry = existing || { url, socket: null, status: 'idle', lastError: null, reconnectDelay: this.config.RELAY_RECONNECT_MIN_MS, timer: null };
        entry.status = 'connecting';
        entry.lastError = null;
        this.relays.set(url, entry);

        return new Promise((resolve) => {
            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve();
            };

            const timeout = setTimeout(() => {
                entry.status = 'error';
                entry.lastError = 'connect-timeout';
                try {
                    entry.socket?.close();
                } catch (_) {}
                settle();
            }, this.config.RELAY_CONNECT_TIMEOUT_MS);

            let socket;
            try {
                socket = new this.WebSocketImpl(url);
            } catch (error) {
                entry.status = 'error';
                entry.lastError = error instanceof Error ? error.message : String(error);
                settle();
                return;
            }
            entry.socket = socket;

            socket.onopen = () => {
                entry.status = 'connected';
                entry.reconnectDelay = this.config.RELAY_RECONNECT_MIN_MS;
                // Replay live subscriptions onto a relay that (re)joined late.
                for (const subscription of this.subscriptions.values()) {
                    if (!subscription.closed) this._sendTo(entry, ['REQ', subscription.id, ...subscription.filters]);
                }
                settle();
            };

            socket.onerror = (event) => {
                entry.status = 'error';
                entry.lastError = `${event?.message || 'socket-error'}`;
                settle();
            };

            socket.onclose = () => {
                if (entry.status !== 'error') entry.status = 'disconnected';
                entry.socket = null;
                settle();
                this._scheduleReconnect(entry);
            };

            socket.onmessage = (event) => this._handleFrame(entry, event?.data);
        });
    }

    /** @param {{ url: string, status: string, reconnectDelay: number, timer: any }} entry */
    _scheduleReconnect(entry) {
        if (this.closed) return;
        if (entry.timer) clearTimeout(entry.timer);
        const delay = Math.min(entry.reconnectDelay, this.config.RELAY_RECONNECT_MAX_MS);
        entry.reconnectDelay = Math.min(delay * 2, this.config.RELAY_RECONNECT_MAX_MS);
        entry.timer = setTimeout(() => {
            entry.timer = null;
            if (!this.closed) void this._openRelay(entry.url);
        }, delay);
        if (typeof entry.timer?.unref === 'function') entry.timer.unref();
    }

    /**
     * @param {{ socket: any, status: string }} entry
     * @param {any[]} message
     */
    _sendTo(entry, message) {
        if (!entry.socket || entry.socket.readyState !== WS_OPEN) return false;
        try {
            entry.socket.send(JSON.stringify(message));
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Parse and dispatch one relay frame. Everything here treats `raw` as
     * hostile input.
     * @param {{ url: string }} entry
     * @param {unknown} raw
     */
    _handleFrame(entry, raw) {
        if (typeof raw !== 'string') return;
        if (raw.length > this.config.MAX_RELAY_FRAME_BYTES) return;

        let frame;
        try {
            frame = JSON.parse(raw);
        } catch (_) {
            return;
        }
        if (!Array.isArray(frame) || typeof frame[0] !== 'string') return;

        switch (frame[0]) {
            case 'EVENT':
                this._handleEvent(entry, frame[1], frame[2]);
                return;
            case 'EOSE': {
                const subscription = this.subscriptions.get(`${frame[1]}`);
                if (subscription && !subscription.closed) subscription.onEose?.(entry.url);
                return;
            }
            case 'OK':
                this._handleOk(entry, frame[1], frame[2], frame[3]);
                return;
            case 'CLOSED':
            case 'NOTICE':
            default:
                return;
        }
    }

    /**
     * @param {{ url: string }} entry
     * @param {unknown} subscriptionId
     * @param {any} event
     */
    _handleEvent(entry, subscriptionId, event) {
        const subscription = this.subscriptions.get(`${subscriptionId}`);
        if (!subscription || subscription.closed) return;

        // A relay may send anything at all; only locally verified events that
        // match the filter we actually asked for reach the application.
        if (!this.verifyEvent(event)) return;
        if (event.created_at > Math.floor(this.now() / 1000) + this.config.MAX_EVENT_FUTURE_SKEW_SECONDS) return;
        if (!subscription.filters.some((filter) => eventMatchesFilter(event, filter))) return;

        // Deduplicate: the same gift wrap reaches us from every relay that has
        // it, and the application must see it exactly once.
        if (subscription.seen.has(event.id)) return;
        subscription.seen.add(event.id);
        if (subscription.seen.size > this.config.MAX_SEEN_EVENT_IDS) {
            // Bound the set so a hostile relay cannot grow it without limit.
            const oldest = subscription.seen.values().next().value;
            if (oldest !== undefined) subscription.seen.delete(oldest);
        }

        try {
            subscription.onEvent(event, entry.url);
        } catch (_) {
            // A handler that throws must not take the socket down.
        }
    }

    /**
     * @param {{ url: string }} entry
     * @param {unknown} eventId
     * @param {unknown} accepted
     * @param {unknown} message
     */
    _handleOk(entry, eventId, accepted, message) {
        const pending = this.pendingPublishes.get(`${eventId}`);
        if (!pending) return;
        if (accepted === true) {
            pending.accepted.add(entry.url);
        } else {
            pending.rejected.set(entry.url, `${message || 'rejected'}`);
        }
        if (pending.accepted.size + pending.rejected.size >= this.connectedCount) pending.resolve();
    }

    /**
     * Publish one event to every connected relay.
     *
     * Resolves as soon as every connected relay has answered, or when the
     * publish timeout elapses. A relay that is down simply does not count.
     *
     * @param {any} event a fully signed Nostr event
     * @returns {Promise<{ accepted: string[], rejected: Record<string,string>, attempted: number }>}
     */
    async publish(event) {
        if (this.closed) throw new Error('This relay pool has been closed.');
        if (!this.verifyEvent(event)) throw new Error('Refusing to publish an event that fails local verification.');

        const pending = {
            resolve: () => {},
            accepted: new Set(),
            rejected: new Map(),
            timer: /** @type {any} */ (null)
        };
        const settled = new Promise((resolve) => {
            pending.resolve = resolve;
        });
        this.pendingPublishes.set(event.id, pending);

        let attempted = 0;
        for (const entry of this.relays.values()) {
            if (this._sendTo(entry, ['EVENT', event])) attempted += 1;
        }

        if (attempted === 0) {
            this.pendingPublishes.delete(event.id);
            throw new Error('No Nostr relay is currently reachable.');
        }

        pending.timer = setTimeout(() => pending.resolve(), this.config.RELAY_PUBLISH_TIMEOUT_MS);
        await settled;
        clearTimeout(pending.timer);
        this.pendingPublishes.delete(event.id);

        return {
            accepted: [...pending.accepted],
            rejected: Object.fromEntries(pending.rejected),
            attempted
        };
    }

    /**
     * Subscribe across every relay in the pool.
     *
     * @param {any[]} filters
     * @param {(event: any, relayUrl: string) => void} onEvent
     * @param {{ onEose?: (relayUrl: string) => void }} [handlers]
     * @returns {{ id: string, close: () => void }}
     */
    subscribe(filters, onEvent, { onEose = undefined } = {}) {
        if (this.closed) throw new Error('This relay pool has been closed.');
        if (!Array.isArray(filters) || filters.length === 0) throw new Error('At least one filter is required.');
        if (typeof onEvent !== 'function') throw new Error('A subscription handler is required.');

        this.counter += 1;
        const id = `w25-${this.counter}-${Math.random().toString(36).slice(2, 10)}`;
        const subscription = { id, filters, onEvent, onEose: onEose || null, seen: new Set(), closed: false };
        this.subscriptions.set(id, subscription);

        for (const entry of this.relays.values()) this._sendTo(entry, ['REQ', id, ...filters]);

        return {
            id,
            close: () => {
                if (subscription.closed) return;
                subscription.closed = true;
                subscription.seen.clear();
                this.subscriptions.delete(id);
                for (const entry of this.relays.values()) this._sendTo(entry, ['CLOSE', id]);
            }
        };
    }

    /** Close every subscription and socket, and stop reconnecting. */
    close() {
        this.closed = true;
        for (const subscription of [...this.subscriptions.values()]) {
            subscription.closed = true;
            subscription.seen.clear();
            for (const entry of this.relays.values()) this._sendTo(entry, ['CLOSE', subscription.id]);
        }
        this.subscriptions.clear();

        for (const pending of this.pendingPublishes.values()) {
            clearTimeout(pending.timer);
            pending.resolve();
        }
        this.pendingPublishes.clear();

        for (const entry of this.relays.values()) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = null;
            const socket = entry.socket;
            entry.socket = null;
            entry.status = 'closed';
            if (!socket) continue;
            socket.onopen = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.onmessage = null;
            try {
                socket.close();
            } catch (_) {}
        }
        this.relays.clear();
    }
}

/**
 * @param {string[]} relays
 * @returns {string[]}
 */
export function normalizeRelayUrls(relays) {
    const seen = new Set();
    const out = [];
    for (const relay of relays || []) {
        const url = `${relay || ''}`.trim();
        if (!/^wss:\/\/[^\s]+$/i.test(url)) continue;
        const normalized = url.replace(/\/+$/, '');
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}
