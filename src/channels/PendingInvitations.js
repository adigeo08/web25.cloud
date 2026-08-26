// @ts-check
/**
 * Chat invitations from peers the local user has not approved yet.
 *
 * An invitation that has passed every cryptographic check is still only a
 * *request*. Cryptographic validity says the sender really is the identity they
 * claim; it says nothing about whether the local user wants to talk to them.
 * This queue is where that gap lives: an offer from an unknown peer is parked
 * here, and nothing is sent back until a person decides.
 *
 * Deliberately in-memory only:
 *
 *   - the SDP inside an invitation is short-lived and describes a network
 *     position; persisting it would keep a stale map of somebody's endpoints
 *     long after the offer expired;
 *   - invitations carry a TTL, so a queue that survives a reload would mostly
 *     hold expired entries;
 *   - contacts are the durable record. An invitation is not.
 *
 * The queue holds the sender's identity and the offer needed to answer *if*
 * accepted. It never triggers ICE gathering, never creates an RTCPeerConnection
 * and never sends anything.
 */

const MAX_PENDING = 32;
const MAX_NAME_LENGTH = 64;
/**
 * Control and bidi characters. A profile name comes from a public relay, so it
 * is untrusted text: without this it could reorder the notification it appears
 * in, or impersonate another row.
 */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** @param {string} value */
function safeName(value) {
    return `${value || ''}`.replace(UNSAFE_NAME_CHARS, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

export class PendingInvitations {
    /** @param {{ now?: () => number, max?: number }} [options] */
    constructor({ now = Date.now, max = MAX_PENDING } = {}) {
        this.now = now;
        this.max = max;
        /** @type {Map<string, any>} keyed by sender Nostr public key */
        this._byPeer = new Map();
        /** @type {(() => void)|null} */
        this.onChange = null;
    }

    _notify() {
        this.onChange?.();
    }

    /**
     * Park an invitation from an unapproved peer.
     *
     * One entry per sender: a peer who re-offers replaces their own pending
     * request rather than filling the list, so an unknown peer cannot flood the
     * notification area by repeating.
     *
     * @param {{ bootstrap: any, senderNostrPublicKey: string, npub?: string,
     *           profileName?: string, trustState?: string }} input
     */
    add({ bootstrap, senderNostrPublicKey, npub = '', profileName = '', trustState = 'unknown' }) {
        const peer = `${senderNostrPublicKey || ''}`.trim().toLowerCase();
        if (!peer) throw new Error('A pending invitation needs a sender Nostr public key.');

        this.pruneExpired();

        const record = {
            id: `${peer}:${bootstrap?.session?.sessionId || ''}`,
            peerNostrPublicKey: peer,
            npub,
            profileName: safeName(profileName),
            eciesPublicKey: `${bootstrap?.from?.eciesPublicKey || ''}`.trim().toLowerCase(),
            evmAddress: `${bootstrap?.from?.evmAddress || ''}`.trim().toLowerCase(),
            sessionId: `${bootstrap?.session?.sessionId || ''}`,
            expiresAt: Number(bootstrap?.session?.expiresAt || 0),
            receivedAt: this.now(),
            trustState,
            // Held so Accept can answer without asking the peer to re-offer.
            // Never rendered, never stored, never logged.
            bootstrap
        };

        this._byPeer.set(peer, record);

        // Oldest-first eviction, so a burst from many senders cannot grow
        // without bound either.
        while (this._byPeer.size > this.max) {
            const oldest = [...this._byPeer.values()].sort((a, b) => a.receivedAt - b.receivedAt)[0];
            this._byPeer.delete(oldest.peerNostrPublicKey);
        }

        this._notify();
        return record;
    }

    /** Drop invitations whose bootstrap TTL has passed. */
    pruneExpired() {
        const now = this.now();
        let removed = false;
        for (const [peer, record] of this._byPeer) {
            if (record.expiresAt && record.expiresAt <= now) {
                this._byPeer.delete(peer);
                removed = true;
            }
        }
        if (removed) this._notify();
        return removed;
    }

    /**
     * Everything the notification area shows. The bootstrap is deliberately not
     * included: the UI has no use for an SDP.
     * @returns {any[]} newest first
     */
    list() {
        this.pruneExpired();
        return [...this._byPeer.values()]
            .sort((a, b) => b.receivedAt - a.receivedAt)
            .map(({ bootstrap: _bootstrap, ...rest }) => rest);
    }

    /** @param {string} peerNostrPublicKey */
    get(peerNostrPublicKey) {
        this.pruneExpired();
        return this._byPeer.get(`${peerNostrPublicKey || ''}`.trim().toLowerCase()) || null;
    }

    /** @param {string} peerNostrPublicKey */
    has(peerNostrPublicKey) {
        return Boolean(this.get(peerNostrPublicKey));
    }

    /**
     * Remove and return an invitation, so Accept and Decline both consume it
     * exactly once and a double click cannot answer twice.
     * @param {string} peerNostrPublicKey
     */
    take(peerNostrPublicKey) {
        const peer = `${peerNostrPublicKey || ''}`.trim().toLowerCase();
        const record = this._byPeer.get(peer) || null;
        if (record) {
            this._byPeer.delete(peer);
            this._notify();
        }
        return record;
    }

    /** @param {string} peerNostrPublicKey */
    remove(peerNostrPublicKey) {
        return Boolean(this.take(peerNostrPublicKey));
    }

    get size() {
        this.pruneExpired();
        return this._byPeer.size;
    }

    /** Drop everything. Called when the wallet locks. */
    clear() {
        if (this._byPeer.size === 0) return;
        this._byPeer.clear();
        this._notify();
    }
}
