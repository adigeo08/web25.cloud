// @ts-check
/**
 * Presence and mutual intent for the Direct Messenger.
 *
 * Three things are deliberately kept apart:
 *
 *   presence      — "this identity is reachable right now". Public, coarse,
 *                   and says nothing about who wants to talk to whom.
 *   intent        — "I would like to talk to you". Private, gift-wrapped, and
 *                   addressed to one peer: how a stranger asks.
 *   conversation  — "our conversation is open on my screen", or closed again.
 *                   Private as well, and only between saved contacts, whose
 *                   messages already travel over Nostr whether or not anybody
 *                   is looking. It decides one thing: a direct WebRTC link is
 *                   worth trying only while *both* have the same conversation
 *                   open.
 *
 * Seeing someone online is not permission to call them, so a WebRTC handshake
 * only begins once intent — or, for contacts, an open conversation — is
 * mutual. Until then no SDP, no ICE candidate and no invitation is created.
 *
 * Presence uses NIP-38 user statuses (kind 30315) under our own `d` identifier,
 * so it never overwrites a user's general status. The beacon carries no content:
 * its existence and freshness are the whole signal.
 */

import { NOSTR_CONFIG } from '../config/nostr.config.js';

/** Who has to move next before a conversation can start. */
export const INTENT = /** @type {const} */ ({
    /** Neither side has asked. */
    NONE: 'none',
    /** We asked; waiting for them to select us back. */
    SENT: 'sent',
    /** They asked; waiting for the local user to accept. */
    RECEIVED: 'received',
    /** Both sides asked — and only now may a handshake begin. */
    MUTUAL: 'mutual'
});

/** Whether a conversation is on screen, as each side announces it. */
export const CONVERSATION = /** @type {const} */ ({
    OPEN: 'open',
    CLOSED: 'closed'
});

export class NostrPresenceService {
    /**
     * @param {{ pool: any, signer: any, config?: typeof NOSTR_CONFIG,
     *           onPresenceChange?: (pubkey: string, online: boolean) => void,
     *           onIntentChange?: (pubkey: string, state: string) => void,
     *           onMutualIntent?: (pubkey: string) => void,
     *           onConversationMutual?: (pubkey: string, room: string) => void,
     *           onPeerConversationClosed?: (pubkey: string, room: string) => void,
     *           onError?: (error: Error) => void,
     *           now?: () => number }} options
     */
    constructor({
        pool,
        signer,
        config = NOSTR_CONFIG,
        onPresenceChange = null,
        onIntentChange = null,
        onMutualIntent = null,
        onConversationMutual = null,
        onPeerConversationClosed = null,
        onError = null,
        now = Date.now
    }) {
        this.pool = pool;
        this.signer = signer;
        this.config = config;
        this.onPresenceChange = onPresenceChange;
        this.onIntentChange = onIntentChange;
        this.onMutualIntent = onMutualIntent;
        this.onConversationMutual = onConversationMutual;
        this.onPeerConversationClosed = onPeerConversationClosed;
        this.onError = onError;
        this.now = now;

        this.localNostrPublicKey = '';
        /** @type {Map<string, number>} peer pubkey → last beacon (ms) */
        this.presence = new Map();
        /** @type {Map<string, number>} peer pubkey → when we asked (ms) */
        this.sentIntent = new Map();
        /** @type {Map<string, number>} peer pubkey → when they asked (ms) */
        this.receivedIntent = new Map();
        /** @type {Set<string>} peers whose mutual state we already announced */
        this.announced = new Set();

        /**
         * The one conversation open on this screen, if any.
         * @type {{ peer: string, room: string, since: number }|null}
         */
        this.activeConversation = null;
        /**
         * What each contact last said about their side of our conversation.
         * @type {Map<string, { state: string, room: string, at: number }>}
         */
        this.peerConversations = new Map();
        /** @type {Set<string>} peers whose open-on-both-sides we already announced */
        this.conversationAnnounced = new Set();

        this.presenceSubscription = null;
        this.beaconTimer = null;
        this.watched = new Set();
    }

    /** @param {unknown} error */
    _fail(error) {
        if (this.onError) this.onError(error instanceof Error ? error : new Error(String(error)));
    }

    /**
     * Begin publishing our own presence beacon.
     * @param {{ localNostrPublicKey: string }} params
     */
    async start({ localNostrPublicKey }) {
        this.localNostrPublicKey = `${localNostrPublicKey || ''}`.toLowerCase();
        if (!this.localNostrPublicKey) throw new Error('A local Nostr identity is required to announce presence.');

        await this.publishPresence();
        if (this.beaconTimer) clearInterval(this.beaconTimer);
        this.beaconTimer = setInterval(() => {
            void this.publishPresence().catch((error) => this._fail(error));
        }, this.config.PRESENCE_REPUBLISH_MS);
        if (typeof (/** @type {any} */ (this.beaconTimer)?.unref) === 'function') {
            /** @type {any} */ (this.beaconTimer).unref();
        }
    }

    /**
     * Publish the presence beacon.
     *
     * Content is empty on purpose: this says "reachable", nothing more.
     */
    async publishPresence() {
        const nowSeconds = Math.floor(this.now() / 1000);
        const event = await this.signer.nostrSignEvent({
            kind: this.config.PRESENCE_KIND,
            created_at: nowSeconds,
            tags: [
                ['d', this.config.PRESENCE_IDENTIFIER],
                // NIP-40: relays may drop the beacon once it is meaningless.
                ['expiration', `${nowSeconds + Math.floor(this.config.PRESENCE_TTL_MS / 1000)}`]
            ],
            content: ''
        });
        await this.pool.publish(event);
        return event;
    }

    /**
     * Watch a set of peers for presence. Safe to call repeatedly as the contact
     * list changes; the previous subscription is replaced.
     *
     * @param {string[]} peerPublicKeys
     */
    watch(peerPublicKeys) {
        const peers = [...new Set((peerPublicKeys || []).map((key) => `${key}`.toLowerCase()).filter(Boolean))];
        this.watched = new Set(peers);

        try {
            this.presenceSubscription?.close();
        } catch (_) {
            // Already gone.
        }
        this.presenceSubscription = null;
        if (peers.length === 0) return null;

        this.presenceSubscription = this.pool.subscribe(
            [
                {
                    kinds: [this.config.PRESENCE_KIND],
                    authors: peers,
                    '#d': [this.config.PRESENCE_IDENTIFIER],
                    since: Math.floor((this.now() - this.config.PRESENCE_TTL_MS) / 1000)
                }
            ],
            (event) => this._handlePresence(event)
        );
        return this.presenceSubscription;
    }

    /** @param {any} event a pool-verified presence beacon */
    _handlePresence(event) {
        const author = `${event.pubkey}`.toLowerCase();
        if (!this.watched.has(author)) return;

        const seenAt = event.created_at * 1000;
        const previous = this.presence.get(author) || 0;
        if (seenAt <= previous) return;

        const wasOnline = this.isOnline(author);
        this.presence.set(author, seenAt);
        if (!wasOnline) this.onPresenceChange?.(author, true);
    }

    /**
     * Presence is a freshness question, not a stored flag: a beacon that has
     * aged out means offline without anyone having to say so.
     * @param {string} peerPublicKey
     */
    isOnline(peerPublicKey) {
        const seenAt = this.presence.get(`${peerPublicKey}`.toLowerCase());
        if (!seenAt) return false;
        return this.now() - seenAt <= this.config.PRESENCE_TTL_MS;
    }

    /**
     * Send "I would like to talk to you" to a peer.
     *
     * This is the whole of what selecting a contact does. It carries no SDP and
     * starts no handshake; if the peer never selects us back, nothing further
     * happens.
     *
     * @param {string} peerPublicKey
     * @param {(peer: string, kind: number, content: string) => Promise<any>} sendGiftWrapped
     */
    async sendChatRequest(peerPublicKey, sendGiftWrapped) {
        const peer = `${peerPublicKey}`.toLowerCase();
        await sendGiftWrapped(
            peer,
            this.config.WEB25_CHAT_REQUEST_KIND,
            JSON.stringify({ type: 'web25-chat-request', at: this.now() })
        );
        this.sentIntent.set(peer, this.now());
        this._settleIntent(peer);
        return this.intentState(peer);
    }

    /**
     * Record an inbound chat request. Called by the DM session when a
     * gift wrap turns out to be a request rather than an invitation.
     *
     * `at` is the sender's own timestamp, so a request pulled out of the inbox
     * history counts from when it was written rather than from when this client
     * happened to read it — otherwise every reload would revive stale intent as
     * fresh. A timestamp in the future is clamped to now: nobody gets to mint
     * an intent that never goes stale.
     *
     * @param {string} peerPublicKey
     * @param {number} [at] milliseconds; defaults to now
     */
    receiveChatRequest(peerPublicKey, at = this.now()) {
        const peer = `${peerPublicKey}`.toLowerCase();
        this.receivedIntent.set(peer, Math.min(Number(at) || this.now(), this.now()));
        this._settleIntent(peer);
        return this.intentState(peer);
    }

    /**
     * @param {string} peerPublicKey
     * @returns {string} one of `INTENT`
     */
    intentState(peerPublicKey) {
        const peer = `${peerPublicKey}`.toLowerCase();
        const sent = this._isFresh(this.sentIntent.get(peer));
        const received = this._isFresh(this.receivedIntent.get(peer));
        if (sent && received) return INTENT.MUTUAL;
        if (sent) return INTENT.SENT;
        if (received) return INTENT.RECEIVED;
        return INTENT.NONE;
    }

    /** @param {number|undefined} at */
    _isFresh(at) {
        return Boolean(at) && this.now() - /** @type {number} */ (at) <= this.config.CHAT_REQUEST_TTL_MS;
    }

    /** @param {string} peer */
    _settleIntent(peer) {
        const state = this.intentState(peer);
        this.onIntentChange?.(peer, state);
        if (state !== INTENT.MUTUAL) {
            this.announced.delete(peer);
            return;
        }
        // Both sides have now asked; announce once so the caller can start the
        // handshake exactly one time.
        if (this.announced.has(peer)) return;
        this.announced.add(peer);
        this.onMutualIntent?.(peer);
    }

    /**
     * Which side creates the WebRTC offer once intent is mutual.
     *
     * Both peers reach the mutual state at roughly the same moment, so the
     * choice has to be deterministic and identical on both sides or they would
     * glare — two offers, no answer.
     *
     * @param {string} peerPublicKey
     * @returns {boolean} true when this side should offer
     */
    shouldInitiate(peerPublicKey) {
        return this.localNostrPublicKey < `${peerPublicKey}`.toLowerCase();
    }

    /** Forget intent for one peer, e.g. after leaving a conversation. */
    clearIntent(peerPublicKey) {
        const peer = `${peerPublicKey}`.toLowerCase();
        this.sentIntent.delete(peer);
        this.receivedIntent.delete(peer);
        this.announced.delete(peer);
        this.onIntentChange?.(peer, INTENT.NONE);
    }

    /**
     * Say "our conversation is open here" to a saved contact.
     *
     * The announcement starts nothing by itself. If they already said the same
     * thing, recently, the conversation is open on both sides and the direct
     * link may be tried; otherwise their side answers when it is open too.
     *
     * @param {string} peerPublicKey
     * @param {string} room the persistent room both sides derive
     * @param {(peer: string, kind: number, content: string) => Promise<any>} sendGiftWrapped
     * @returns {Promise<boolean>} whether the conversation is now open on both sides
     */
    async openConversation(peerPublicKey, room, sendGiftWrapped) {
        const peer = `${peerPublicKey}`.toLowerCase();
        this.activeConversation = { peer, room: `${room}`, since: this.now() };
        // A new opening is a new chance for a direct link.
        this.conversationAnnounced.delete(peer);
        // Settled before the send: what they already said does not wait on a relay.
        this._settleConversation(peer);
        await this._sendConversation(peer, CONVERSATION.OPEN, `${room}`, false, sendGiftWrapped);
        return this.isConversationMutual(peer);
    }

    /**
     * Withdraw: this side closed the conversation, or switched to another.
     * Best effort — a page that just goes away says nothing, and the other
     * side notices the direct link closing instead.
     *
     * @param {(peer: string, kind: number, content: string) => Promise<any>} sendGiftWrapped
     */
    async closeConversation(sendGiftWrapped) {
        const active = this.activeConversation;
        this.activeConversation = null;
        if (!active) return false;
        this.conversationAnnounced.delete(active.peer);
        try {
            await this._sendConversation(active.peer, CONVERSATION.CLOSED, active.room, false, sendGiftWrapped);
        } catch (error) {
            this._fail(error);
        }
        return true;
    }

    /**
     * Record what a saved contact said about their side of our conversation.
     *
     * The caller has already established that they are a saved contact and
     * that `room` is the one the two of you share. An opening that is not an
     * answer gets one back while the same conversation is open here, so
     * whoever opened first learns that the other is here too; an answer is
     * never answered, so the two cannot echo each other forever.
     *
     * @param {string} peerPublicKey
     * @param {{ state: string, room: string, ack?: boolean, at?: number }} intent `at` in ms, the sender's clock
     * @param {(peer: string, kind: number, content: string) => Promise<any>} sendGiftWrapped
     */
    receiveConversation(peerPublicKey, { state, room, ack = false, at = this.now() }, sendGiftWrapped) {
        const peer = `${peerPublicKey}`.toLowerCase();
        const when = Math.min(Number(at) || this.now(), this.now());
        const previous = this.peerConversations.get(peer);
        // Relays do not promise order: something older than what we know says nothing new.
        if (previous && when < previous.at) return this.isConversationMutual(peer);

        const next = {
            state: state === CONVERSATION.OPEN ? CONVERSATION.OPEN : CONVERSATION.CLOSED,
            room: `${room || ''}`,
            at: when
        };
        this.peerConversations.set(peer, next);

        if (next.state === CONVERSATION.CLOSED) {
            this.conversationAnnounced.delete(peer);
            this.onPeerConversationClosed?.(peer, next.room);
            return false;
        }

        const ours = this.activeConversation;
        if (ours && ours.peer === peer && ours.room === next.room && !ack && this._isConversationFresh(when)) {
            // They opened it again: whatever happened to the last direct link,
            // this is a new chance for one.
            this.conversationAnnounced.delete(peer);
            void this._sendConversation(peer, CONVERSATION.OPEN, ours.room, true, sendGiftWrapped).catch((error) =>
                this._fail(error)
            );
        }
        this._settleConversation(peer);
        return this.isConversationMutual(peer);
    }

    /**
     * Does this contact have our conversation open, as far as anything recent says?
     * @param {string} peerPublicKey
     * @param {string} room
     */
    peerHasConversationOpen(peerPublicKey, room) {
        const entry = this.peerConversations.get(`${peerPublicKey}`.toLowerCase());
        return Boolean(
            entry &&
            entry.state === CONVERSATION.OPEN &&
            entry.room === `${room}` &&
            this._isConversationFresh(entry.at)
        );
    }

    /**
     * Open on both sides: ours is on screen here, and theirs, recently said.
     * @param {string} peerPublicKey
     */
    isConversationMutual(peerPublicKey) {
        const peer = `${peerPublicKey}`.toLowerCase();
        const ours = this.activeConversation;
        return Boolean(ours && ours.peer === peer && this.peerHasConversationOpen(peer, ours.room));
    }

    /** @param {number} at */
    _isConversationFresh(at) {
        return Boolean(at) && this.now() - at <= this.config.CONVERSATION_INTENT_MAX_AGE_MS;
    }

    /** @param {string} peer */
    _settleConversation(peer) {
        if (!this.isConversationMutual(peer) || this.conversationAnnounced.has(peer)) return;
        // Once per opening, so the caller tries one direct link, not one per echo.
        this.conversationAnnounced.add(peer);
        this.onConversationMutual?.(peer, /** @type {any} */ (this.activeConversation).room);
    }

    /**
     * @param {string} peer
     * @param {string} state
     * @param {string} room
     * @param {boolean} ack
     * @param {(peer: string, kind: number, content: string) => Promise<any>} sendGiftWrapped
     */
    async _sendConversation(peer, state, room, ack, sendGiftWrapped) {
        await sendGiftWrapped(
            peer,
            this.config.WEB25_CONVERSATION_KIND,
            JSON.stringify({ type: 'web25-conversation', state, room, ack, at: this.now() })
        );
    }

    /** Stop the beacon and the presence subscription. */
    stop() {
        if (this.beaconTimer) clearInterval(this.beaconTimer);
        this.beaconTimer = null;
        try {
            this.presenceSubscription?.close();
        } catch (_) {
            // Already gone.
        }
        this.presenceSubscription = null;
        this.presence.clear();
        this.sentIntent.clear();
        this.receivedIntent.clear();
        this.announced.clear();
        this.watched.clear();
        this.activeConversation = null;
        this.peerConversations.clear();
        this.conversationAnnounced.clear();
    }
}
