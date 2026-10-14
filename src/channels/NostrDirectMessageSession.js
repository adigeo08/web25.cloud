// @ts-check
/**
 * Orchestrates one Direct Messenger conversation over Nostr.
 *
 * Responsibilities:
 *   - hold the relay pool and the local identity's gift-wrapped inbox;
 *   - turn an inbound gift wrap into either a verified WebRTC invitation or a
 *     Web25 chat envelope handed to `ChannelsService`;
 *   - expose the `{ send(wire) }` fallback handle that `ChannelsService` uses
 *     when the DataChannel is not open.
 *
 * It performs no cryptography of its own: encryption, decryption and signing
 * all go through the wallet-worker-backed signer.
 */

import { NOSTR_CONFIG } from '../config/nostr.config.js';
import { normalizeNostrPublicKey } from '../nostr/nip19.js';
import {
    createNostrChatEvent,
    createNostrDMInvitation,
    createNostrGiftWrappedRumor,
    nostrCore,
    openNostrGiftWrap,
    subscribeNostrInbox,
    verifyNostrDMInvitation
} from './NostrDirectMessageBootstrap.js';
import { InboxLedger } from './InboxLedger.js';

export class NostrDirectMessageSession {
    /**
     * @param {{
     *   pool: any,
     *   signer: any,
     *   onInvitation?: (bootstrap: any, context: { senderNostrPublicKey: string }) => void|Promise<void>,
     *   onChatEnvelope?: (wire: string, context: { senderNostrPublicKey: string }) => void|Promise<void>,
     *   onChatRequest?: (senderNostrPublicKey: string,
     *                     context: { createdAtSeconds: number }) => void|Promise<void>,
     *   onError?: (error: Error) => void,
     *   config?: typeof NOSTR_CONFIG,
     *   ledger?: InboxLedger,
     *   now?: () => number
     * }} options
     */
    constructor({
        pool,
        signer,
        onInvitation = null,
        onChatEnvelope = null,
        onChatRequest = null,
        onError = null,
        config = NOSTR_CONFIG,
        ledger = new InboxLedger(),
        now = Date.now
    }) {
        this.pool = pool;
        this.signer = signer;
        this.config = config;
        this.onInvitation = onInvitation;
        this.onChatEnvelope = onChatEnvelope;
        this.onChatRequest = onChatRequest;
        this.onError = onError;
        /** What this browser already acted on, across reconnects and reloads. */
        this.ledger = ledger;
        this.now = now;
        /** When this page's inbox subscription began; older offers are not ours. */
        this.startedAt = 0;

        this.localNostrPublicKey = '';
        this.localNpub = '';
        this.localAddress = '';
        /** The peer this conversation is bound to; nothing else is accepted. */
        this.peerNostrPublicKey = '';
        /** Session id of the offer we sent, used to bind the answer back to it. */
        this.offerSessionId = null;
        this.subscription = null;
        this.started = false;
        /** In-flight `start()`, so concurrent callers share one connect. */
        this._starting = null;
    }

    /** @param {Error|unknown} error */
    _fail(error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        if (this.onError) this.onError(wrapped);
    }

    /**
     * Resolve the local Nostr identity, connect the relays and subscribe to the
     * gift-wrapped inbox. Safe to call repeatedly.
     * @param {{ localAddress?: string }} [params]
     */
    async start({ localAddress = '' } = {}) {
        const identity = await this.signer.getNostrIdentity();
        if (!identity?.nostrPublicKey) throw new Error('Nostr identity is unavailable: unlock your wallet first.');

        this.localNostrPublicKey = identity.nostrPublicKey;
        this.localNpub = identity.npub;
        if (localAddress) this.localAddress = localAddress;

        const identityResult = { npub: this.localNpub, nostrPublicKey: this.localNostrPublicKey };
        if (this.started) return identityResult;
        if (this._starting) {
            await this._starting;
            return identityResult;
        }

        this._starting = (async () => {
            // Before the first event can arrive: replays of anything an
            // earlier page already handled are recognised from the start.
            await this.ledger.load(this.localNostrPublicKey);
            await this.pool.connect();
            if (!this.startedAt) this.startedAt = this.now();
            this.subscription = subscribeNostrInbox({
                pool: this.pool,
                localNostrPublicKey: this.localNostrPublicKey,
                onGiftWrap: (event) => void this._handleGiftWrap(event)
            });
            this.started = true;
        })();

        try {
            await this._starting;
        } finally {
            this._starting = null;
        }
        return identityResult;
    }

    /**
     * Forget the peer this conversation was bound to, while staying subscribed
     * so a new invitation can still arrive.
     */
    clearPeer() {
        this.peerNostrPublicKey = '';
        this.offerSessionId = null;
    }

    /** Close the inbox subscription. The pool itself is owned by the caller. */
    stop() {
        try {
            this.subscription?.close();
        } catch (_) {}
        this.subscription = null;
        this.started = false;
        this.clearPeer();
    }

    /** @param {string} value npub or hex */
    setPeer(value) {
        this.peerNostrPublicKey = normalizeNostrPublicKey(value);
        return this.peerNostrPublicKey;
    }

    /**
     * The handle `ChannelsService` uses when WebRTC is unavailable. It receives
     * the already signed + ECIES-encrypted Web25 payload and does nothing to it
     * beyond wrapping it for the relays.
     * @returns {{ send: (wire: string) => Promise<boolean> }}
     */
    createFallback() {
        return {
            send: async (wire) => {
                if (!this.peerNostrPublicKey) return false;
                const { event } = await createNostrChatEvent({
                    signer: this.signer,
                    recipient: this.peerNostrPublicKey,
                    wire
                });
                const result = await this.pool.publish(event);
                return result.accepted.length > 0;
            }
        };
    }

    /**
     * Send an arbitrary gift-wrapped rumor to a peer.
     *
     * Used for chat requests, which must travel the same private path as
     * everything else in the DM layer: a relay sees only a wrap addressed to a
     * `#p` tag, never who asked whom.
     *
     * @param {string} peerPublicKey
     * @param {number} kind
     * @param {string} content
     */
    async sendGiftWrapped(peerPublicKey, kind, content) {
        const { event } = await createNostrGiftWrappedRumor({
            signer: this.signer,
            recipient: peerPublicKey,
            kind,
            content
        });
        const result = await this.pool.publish(event);
        if (result.accepted.length === 0) throw new Error('No Nostr relay accepted the message.');
        return event;
    }

    /**
     * Build, wrap and publish a WebRTC invitation.
     *
     * @param {{ identity: { address: string }, eciesPublicKey: string,
     *           role: 'offer'|'answer', webrtcDescription: RTCSessionDescriptionInit,
     *           recipient: string, recipientEciesPublicKey?: string|null,
     *           sessionId?: string|null, replyToSessionId?: string|null }} params
     */
    async sendInvitation({
        identity,
        eciesPublicKey,
        role,
        webrtcDescription,
        recipient,
        recipientEciesPublicKey = null,
        sessionId = null,
        replyToSessionId = null
    }) {
        const { event, bootstrap, recipientNostrPublicKey } = await createNostrDMInvitation({
            signer: this.signer,
            identity,
            eciesPublicKey,
            role,
            webrtcDescription,
            recipient,
            recipientEciesPublicKey,
            sessionId,
            replyToSessionId,
            ttlMs: this.config.INVITATION_TTL_MS
        });

        const result = await this.pool.publish(event);
        if (result.accepted.length === 0) {
            throw new Error('No Nostr relay accepted the invitation. Check your relay list and try again.');
        }

        this.peerNostrPublicKey = recipientNostrPublicKey;
        if (role === 'offer') this.offerSessionId = bootstrap.session.sessionId;

        return { bootstrap, relays: result.accepted, eventId: event.id };
    }

    /**
     * @param {any} giftWrap
     */
    async _handleGiftWrap(giftWrap) {
        // The same gift wrap again — another relay, a reconnect, a reload — is
        // dropped before any decryption.
        if (giftWrap?.id && !this.ledger.claim(`wrap:${giftWrap.id}`)) return;

        let opened;
        try {
            opened = await openNostrGiftWrap({
                signer: this.signer,
                giftWrap,
                localNostrPublicKey: this.localNostrPublicKey
            });
        } catch (_) {
            // Gift wraps we cannot open are not ours to worry about: a relay
            // may hand us anything at all.
            return;
        }

        const { rumor, senderNostrPublicKey } = opened;

        // A request or an invitation is acted on once, ever: re-wrapped or
        // re-published, the same rumor is still the same question. The hash is
        // computed here — a sender's claimed id is not trusted to be unique.
        if (rumor.kind === this.config.WEB25_CHAT_REQUEST_KIND || rumor.kind === this.config.WEB25_SIGNALING_KIND) {
            const rumorHash = nostrCore.getEventHash({ ...rumor, pubkey: senderNostrPublicKey });
            if (!this.ledger.claim(`rumor:${rumorHash}`)) return;
        }

        if (rumor.kind === this.config.WEB25_CHAT_REQUEST_KIND) {
            // Intent only. Nothing is negotiated here — a handshake starts
            // solely when the local user has also consented to this peer.
            //
            // The rumor's `created_at` travels with it: the inbox deliberately
            // looks days back, and without the sender's own timestamp every
            // request in that history would look like it had just arrived.
            try {
                await this.onChatRequest?.(senderNostrPublicKey, {
                    createdAtSeconds: Number(rumor.created_at) || 0
                });
            } catch (error) {
                this._fail(error);
            }
            return;
        }

        if (rumor.kind === this.config.NIP17_CHAT_KIND) {
            if (!this.peerNostrPublicKey || senderNostrPublicKey !== this.peerNostrPublicKey) return;
            try {
                await this.onChatEnvelope?.(rumor.content, { senderNostrPublicKey });
            } catch (error) {
                this._fail(error);
            }
            return;
        }

        if (rumor.kind !== this.config.WEB25_SIGNALING_KIND) return;

        try {
            const bootstrap = await verifyNostrDMInvitation({
                signer: this.signer,
                rumor,
                senderNostrPublicKey,
                localNostrPublicKey: this.localNostrPublicKey,
                localAddress: this.localAddress,
                expectedReplyToSessionId: bootstrapIsAnswer(rumor, this.offerSessionId)
            });
            // An offer belongs to the session it was made for. One from before
            // this page's inbox began was made for an earlier one: answering
            // it, or asking about it again, would start a conversation nobody
            // is waiting for.
            const createdAt = Number(bootstrap?.session?.createdAt) || 0;
            if (bootstrap.role === 'offer' && createdAt < this.startedAt - this.config.OFFER_SESSION_GRACE_MS) {
                this._fail(new Error('Ignoring an offer made for an earlier session.'));
                return;
            }
            await this.onInvitation?.(bootstrap, { senderNostrPublicKey });
        } catch (error) {
            this._fail(error);
        }
    }
}

/**
 * Only bind an answer to our outstanding offer; an unsolicited offer has no
 * reply id to check.
 * @param {any} rumor
 * @param {string|null} offerSessionId
 * @returns {string|null}
 */
function bootstrapIsAnswer(rumor, offerSessionId) {
    if (!offerSessionId) return null;
    try {
        return JSON.parse(rumor.content)?.role === 'answer' ? offerSessionId : null;
    } catch (_) {
        return null;
    }
}
