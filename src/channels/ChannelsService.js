// @ts-check

import { eciesEncrypt, verifySignature, evmAddressFromPublicKey } from './ecies.js';
import { createLocalWalletSigner } from '../auth/LocalWalletService.js';
import { NOSTR_CONFIG } from '../config/nostr.config.js';

/**
 * The only capabilities this service is granted over the local identity.
 * Everything here is executed inside the dedicated wallet worker; the private
 * key itself is never passed to, or reachable from, ChannelsService.
 *
 * @typedef {{
 *   getPublicKey: () => Promise<string|null>,
 *   signMessage: (message: string) => Promise<string>,
 *   eciesDecrypt: (ciphertext: string) => Promise<string>
 * }} WalletSigner
 */

/**
 * The relay fallback handed in by the bootstrap layer. It receives the *already
 * encrypted* Web25 wire payload and is responsible only for getting those bytes
 * to the peer; it never sees plaintext.
 *
 * @typedef {{ send: (wire: string) => Promise<boolean> }} NostrFallback
 */

export const DM_TRANSPORT = /** @type {const} */ ({
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    WEBRTC: 'webrtc',
    NOSTR: 'nostr'
});

/**
 * The single connection state shown to the user.
 *
 * There is deliberately one of these rather than a transport flag next to a
 * peer-count flag: two indicators could disagree, and the user only needs one
 * answer to "does this conversation work?". Transport is a detail of the final
 * state, not a competing status.
 */
export const DM_CONNECTION = /** @type {const} */ ({
    /** No conversation selected. */
    IDLE: 'idle',
    /** Intent sent, waiting for the peer to select us back. */
    AWAITING_PEER: 'awaiting-peer',
    /** Mutual intent; the encrypted invitation is being exchanged over Nostr. */
    HANDSHAKE: 'handshake',
    /** Handshake done, negotiating the direct connection. */
    CONNECTING_WEBRTC: 'connecting-webrtc',
    /** Working, peer to peer. */
    CONNECTED_WEBRTC: 'connected-webrtc',
    /** Working, carried by the relays. */
    CONNECTED_NOSTR: 'connected-nostr',
    /** Was working, now not. */
    DISCONNECTED: 'disconnected'
});

const DEFAULT_RTC_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

/**
 * Encode a WebRTC description + peer identity info into a shareable signal code.
 * @param {RTCSessionDescriptionInit} description
 * @param {string|null} evmAddress
 * @param {string|null} publicKey  — uncompressed secp256k1 "04..." hex
 * @returns {string}
 */
function encodeSignal(description, evmAddress, publicKey) {
    return JSON.stringify({
        description: toBase64(JSON.stringify(description)),
        evmAddress: evmAddress || null,
        publicKey: publicKey || null
    });
}

/**
 * Decode a signal code into its parts.
 * @param {string} rawCode
 * @returns {{ description: RTCSessionDescriptionInit, evmAddress: string|null, publicKey: string|null }}
 */
function decodeSignal(rawCode) {
    const clean = `${rawCode || ''}`.trim();
    if (!clean) throw new Error('Signal code is required.');

    try {
        const parsed = JSON.parse(clean);
        if (parsed?.description) {
            return {
                description: JSON.parse(fromBase64(parsed.description)),
                evmAddress: parsed.evmAddress || null,
                publicKey: parsed.publicKey || null
            };
        }
    } catch (_) {}

    throw new Error('Invalid signal code format.');
}

function toBase64(value) {
    if (typeof btoa === 'function') return btoa(value);
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8').toString('base64');
    throw new Error('Base64 encoder unavailable in this environment.');
}

function fromBase64(value) {
    if (typeof atob === 'function') return atob(value);
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64').toString('utf8');
    throw new Error('Base64 decoder unavailable in this environment.');
}

function generateHexKey(byteLength = 8) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return [...bytes].map((item) => item.toString(16).padStart(2, '0')).join('');
}

/** @param {string} key */
function comparableKey(key) {
    return `${key || ''}`.trim().toLowerCase().replace(/^0x/, '');
}

function verifySignalIdentity(signal, label = 'signal') {
    if (!signal?.publicKey || !signal?.evmAddress) {
        throw new Error(`Missing peer identity: ${label} must contain both publicKey and evmAddress.`);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(signal.evmAddress)) {
        throw new Error(`Malformed peer identity: ${label} contains an invalid evmAddress.`);
    }
    let derivedAddress;
    try {
        derivedAddress = evmAddressFromPublicKey(signal.publicKey);
    } catch (_) {
        throw new Error(`Malformed peer identity: ${label} contains an invalid publicKey.`);
    }
    if (derivedAddress.toLowerCase() !== signal.evmAddress.toLowerCase()) {
        throw new Error('Peer identity verification failed: public key does not match claimed address.');
    }
}

/**
 * Never keep a Node test process alive on account of a transport timer.
 * `unref` does not exist in browsers, where this is a no-op.
 * @param {any} timer
 */
function unrefTimer(timer) {
    if (timer && typeof timer.unref === 'function') timer.unref();
}

export default class ChannelsService {
    /**
     * @param {{ rtcConfig?: RTCConfiguration, signer?: WalletSigner|null,
     *           nostrFallback?: NostrFallback|null, transportConfig?: any }} [options]
     */
    constructor({ rtcConfig = DEFAULT_RTC_CONFIG, signer = null, nostrFallback = null, transportConfig = NOSTR_CONFIG } = {}) {
        this.rtcConfig = rtcConfig;
        this.peerConnection = null;
        this.dataChannel = null;
        this.currentChannel = '';
        this.currentPeerCount = 0;
        this.messageIds = new Set();
        this.listeners = new Set();
        this.identityAddress = 'anonymous';
        this.role = '';
        /**
         * True while the conversation is a saved contact's persistent room:
         * the peer's keys come from the contact record, Nostr carries it from
         * the first message, and WebRTC is an upgrade on top rather than the
         * thing that makes it work.
         */
        this.persistentRoom = false;
        this.peerPublicKey = '';
        this.peerAddress = '';
        this._fileBuffers = {};
        this._fileInfos = {};
        /** @type {WalletSigner} */
        this._signer = signer || createLocalWalletSigner();

        /** @type {NostrFallback|null} */
        this._nostrFallback = nostrFallback;
        this._transportConfig = transportConfig;
        /** Current message transport. WebRTC is always preferred. */
        this.transport = DM_TRANSPORT.DISCONNECTED;
        /** The one state the UI renders. Derived, never set from two places. */
        this.connectionState = DM_CONNECTION.IDLE;
        this._connectTimer = null;
        this._disconnectTimer = null;
    }

    /**
     * Recompute and emit the single connection state.
     *
     * Every transport change funnels through here, so the UI can never be shown
     * two contradictory flags.
     *
     * @param {string} [reason]
     */
    _syncConnectionState(reason = '') {
        const next = this._deriveConnectionState();
        if (next === this.connectionState) return;
        this.connectionState = next;
        this.emit({ type: 'connection-state', state: next, transport: this.transport, reason });
    }

    /** @returns {string} one of `DM_CONNECTION` */
    _deriveConnectionState() {
        if (this.dataChannel?.readyState === 'open') return DM_CONNECTION.CONNECTED_WEBRTC;

        // A contact's room works over the relays from the moment it opens. A
        // direct link being tried, failing or dropping changes the route, not
        // whether the conversation works — so it never shows as connecting.
        if (this.persistentRoom) {
            return this.hasVerifiedPeerIdentity() && this.canUseNostrFallback
                ? DM_CONNECTION.CONNECTED_NOSTR
                : DM_CONNECTION.DISCONNECTED;
        }

        switch (this.transport) {
            case DM_TRANSPORT.NOSTR:
                // The relay path only counts as connected once there is a peer
                // to carry messages to.
                return this.hasVerifiedPeerIdentity() ? DM_CONNECTION.CONNECTED_NOSTR : DM_CONNECTION.DISCONNECTED;
            case DM_TRANSPORT.CONNECTING:
                return DM_CONNECTION.CONNECTING_WEBRTC;
            case DM_TRANSPORT.WEBRTC:
                return DM_CONNECTION.CONNECTED_WEBRTC;
            default:
                return this.currentChannel ? DM_CONNECTION.DISCONNECTED : DM_CONNECTION.IDLE;
        }
    }

    /**
     * States the conversation passes through before any transport exists.
     * Driven by the presence/intent layer, which owns everything up to the
     * point where an invitation is actually exchanged.
     *
     * @param {'idle'|'awaiting-peer'|'handshake'} state
     */
    setPreConnectionState(state) {
        if (this.connectionState === state) return;
        this.connectionState = state;
        this.emit({ type: 'connection-state', state, transport: this.transport, reason: 'signalling' });
    }

    /**
     * Attach (or detach, with `null`) the Nostr relay fallback.
     * @param {NostrFallback|null} fallback
     */
    setNostrFallback(fallback) {
        this._nostrFallback = fallback || null;
    }

    /** @returns {boolean} */
    get canUseNostrFallback() {
        return Boolean(this._nostrFallback && typeof this._nostrFallback.send === 'function');
    }

    /**
     * @param {string} transport
     * @param {string} [reason]
     */
    _setTransport(transport, reason = '') {
        if (this.transport === transport) return;
        this.transport = transport;
        this.emit({ type: 'transport', transport, reason });
        this._syncConnectionState(reason);
    }

    _clearTransportTimers() {
        if (this._connectTimer) clearTimeout(this._connectTimer);
        if (this._disconnectTimer) clearTimeout(this._disconnectTimer);
        this._connectTimer = null;
        this._disconnectTimer = null;
    }

    /**
     * Arm the WebRTC connection deadline. Only once it elapses without an open
     * DataChannel does the relay fallback take over — a WebRTC attempt is given
     * its full negotiation window first.
     */
    _beginConnecting() {
        this._clearTransportTimers();
        this._setTransport(DM_TRANSPORT.CONNECTING, 'negotiating');
        this._connectTimer = setTimeout(() => {
            this._connectTimer = null;
            if (this.dataChannel?.readyState === 'open') return;
            this._fallBack('webrtc-timeout');
        }, this._transportConfig.WEBRTC_CONNECT_TIMEOUT_MS);
        unrefTimer(this._connectTimer);
    }

    /** WebRTC came up (or came back): it is always the preferred transport. */
    _promoteToWebrtc() {
        this._clearTransportTimers();
        this._setTransport(DM_TRANSPORT.WEBRTC, 'datachannel-open');
    }

    /** @param {string} reason */
    _fallBack(reason) {
        this._clearTransportTimers();
        if (this.canUseNostrFallback) {
            this._setTransport(DM_TRANSPORT.NOSTR, reason);
        } else {
            this._setTransport(DM_TRANSPORT.DISCONNECTED, reason);
        }
    }

    /**
     * A `disconnected` ICE state is routinely transient, so it only starts a
     * grace period. `failed`/`closed` are terminal and fall back at once.
     */
    _scheduleDisconnectFallback() {
        if (this._disconnectTimer || this.transport === DM_TRANSPORT.NOSTR) return;
        this._disconnectTimer = setTimeout(() => {
            this._disconnectTimer = null;
            const state = `${this.peerConnection?.connectionState || this.peerConnection?.iceConnectionState || ''}`.toLowerCase();
            if (this.dataChannel?.readyState === 'open' || state === 'connected' || state === 'completed') return;
            this._fallBack('webrtc-disconnected');
        }, this._transportConfig.WEBRTC_DISCONNECT_GRACE_MS);
        unrefTimer(this._disconnectTimer);
    }

    onUpdate(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event) {
        this.listeners.forEach((listener) => listener(event));
    }

    async requireAuthenticatedLocalIdentity(identity, label = 'session') {
        let ownPublicKey = null;
        try {
            ownPublicKey = await this._signer.getPublicKey();
        } catch (_) {
            ownPublicKey = null;
        }
        if (!ownPublicKey) {
            throw new Error(`Cannot create ${label}: wallet is locked or the signing worker is unavailable.`);
        }

        const ownAddress = evmAddressFromPublicKey(ownPublicKey);
        const claimedAddress = `${identity?.address || identity?.evmAddress || ''}`.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(claimedAddress)) {
            throw new Error(`Cannot create ${label}: valid local evmAddress is required.`);
        }
        if (ownAddress.toLowerCase() !== claimedAddress.toLowerCase()) {
            throw new Error(`Cannot create ${label}: local publicKey does not match provided evmAddress.`);
        }

        return { publicKey: ownPublicKey, evmAddress: claimedAddress };
    }

    hasVerifiedPeerIdentity() {
        if (!this.peerPublicKey || !this.peerAddress) return false;
        try {
            return evmAddressFromPublicKey(this.peerPublicKey).toLowerCase() === this.peerAddress.toLowerCase();
        } catch (_) {
            return false;
        }
    }

    /**
     * Is this signal from the peer the room is already bound to? A room's
     * identity comes from the saved contact and is never replaced by one a
     * signal brings along.
     *
     * @param {{ publicKey?: string|null, evmAddress?: string|null }} signal
     */
    _isCurrentPeer(signal) {
        return (
            comparableKey(signal?.publicKey || '') === comparableKey(this.peerPublicKey) &&
            comparableKey(signal?.evmAddress || '') === comparableKey(this.peerAddress)
        );
    }

    /**
     * Open the persistent room with a saved contact.
     *
     * Nothing is negotiated: the contact record already holds their verified
     * ECIES key and EVM address, which is everything a message needs — it is
     * encrypted to that key and its signature is checked against it — so the
     * conversation is usable over Nostr at once. A direct WebRTC link may be
     * added later, while both sides have it open.
     *
     * @param {string} roomKey the persistent room both sides derive
     * @param {{ eciesPublicKey: string, evmAddress: string }} peer from the saved contact
     * @param {{ address?: string, evmAddress?: string }} identity
     */
    async openContactRoom(roomKey, peer, identity) {
        const normalized = this.normalizeChannel(roomKey);
        if (!normalized) throw new Error('Room key is required.');
        const contactSignal = { publicKey: peer?.eciesPublicKey || null, evmAddress: peer?.evmAddress || null };
        verifySignalIdentity(contactSignal, 'contact');
        const localIdentity = await this.requireAuthenticatedLocalIdentity(identity, 'conversation');

        // The same room, already open: there is nothing to set up again.
        if (this.persistentRoom && this.currentChannel === normalized && this._isCurrentPeer(contactSignal)) {
            return { channel: normalized, reopened: false };
        }

        await this.leaveChannel();
        this.currentChannel = normalized;
        this.persistentRoom = true;
        this.role = '';
        this.identityAddress = localIdentity.evmAddress;
        this.peerPublicKey = `${peer.eciesPublicKey}`;
        this.peerAddress = `${peer.evmAddress}`;
        this.messageIds.clear();
        this._setTransport(this.canUseNostrFallback ? DM_TRANSPORT.NOSTR : DM_TRANSPORT.DISCONNECTED, 'room-open');
        this._syncConnectionState('room-open');
        this.emit({ type: 'room-open', channel: normalized });
        return { channel: normalized, reopened: true };
    }

    /**
     * Offer a direct link inside the open room. The room, its peer and the
     * thread stay as they are; messages keep going over Nostr until the
     * DataChannel opens.
     *
     * @param {{ address?: string, evmAddress?: string }} identity
     */
    async startWebrtcOffer(identity) {
        if (!this.persistentRoom || !this.hasVerifiedPeerIdentity()) {
            throw new Error('Open the conversation before offering a direct link.');
        }
        const localIdentity = await this.requireAuthenticatedLocalIdentity(identity, 'host offer');
        this._closePeerConnection();
        this.role = 'host';
        const peer = this.createPeerConnection();
        const channel = peer.createDataChannel('web25-direct-messenger');
        this.bindDataChannel(channel);
        this.dataChannel = channel;
        const payload = await this.createOfferSignalPayload(localIdentity);
        this._beginConnecting();
        return payload;
    }

    /**
     * Answer a direct-link offer inside the open room. The offer has to come
     * from the key the room is bound to; anything else is refused before an
     * `RTCPeerConnection` exists, so no ICE is gathered for it.
     *
     * @param {{ description: RTCSessionDescriptionInit, evmAddress: string, publicKey: string }} offerPayload
     * @param {{ address?: string, evmAddress?: string }} identity
     */
    async answerWebrtcOffer(offerPayload, identity) {
        if (!this.persistentRoom || !this.hasVerifiedPeerIdentity()) {
            throw new Error('Open the conversation before answering a direct link.');
        }
        verifySignalIdentity(offerPayload, 'offer');
        if (!this._isCurrentPeer(offerPayload)) {
            throw new Error('Offer identity does not match this conversation.');
        }
        const localIdentity = await this.requireAuthenticatedLocalIdentity(identity, 'answer');
        this._closePeerConnection();
        this.role = 'guest';
        this.createPeerConnection();
        const answer = await this.createAnswerSignalPayloadFromOfferPayload(offerPayload, localIdentity);
        this._beginConnecting();
        return answer;
    }

    /**
     * Drop the direct link and stay in the room: the conversation carries on
     * over Nostr. Used when the other side closes it, or this side stops
     * looking at it.
     *
     * @param {string} [reason]
     */
    closeWebrtc(reason = 'webrtc-closed') {
        const hadLink = Boolean(this.peerConnection || this.dataChannel);
        this._clearTransportTimers();
        this._closePeerConnection();
        this.role = '';
        this.currentPeerCount = 0;
        if (!this.currentChannel) return hadLink;
        this._fallBack(reason);
        this._syncConnectionState(reason);
        if (hadLink) this.emit({ type: 'peer-count', count: 0 });
        return hadLink;
    }

    /** Close the peer connection and its DataChannel, quietly. */
    _closePeerConnection() {
        try {
            if (this.dataChannel) {
                this.dataChannel.onopen = null;
                this.dataChannel.onclose = null;
                this.dataChannel.onmessage = null;
                if (this.dataChannel.readyState !== 'closed') this.dataChannel.close();
            }
            if (this.peerConnection) {
                this.peerConnection.ondatachannel = null;
                this.peerConnection.oniceconnectionstatechange = null;
                this.peerConnection.onconnectionstatechange = null;
                this.peerConnection.close();
            }
        } catch (_) {}
        this.peerConnection = null;
        this.dataChannel = null;
    }

    async createHostOfferPayload(roomKey, identity) {
        const normalized = this.normalizeChannel(roomKey);
        if (!normalized) throw new Error('Room key is required.');
        const localIdentity = await this.requireAuthenticatedLocalIdentity(identity, 'host offer');

        await this.leaveChannel();
        this.currentChannel = normalized;
        this.role = 'host';
        this.identityAddress = localIdentity.evmAddress;
        this.peerPublicKey = '';
        this.peerAddress = '';
        this.messageIds.clear();

        const peer = this.createPeerConnection();
        const channel = peer.createDataChannel('web25-direct-messenger');
        this.bindDataChannel(channel);
        this.dataChannel = channel;

        const payload = await this.createOfferSignalPayload(localIdentity);
        this._beginConnecting();
        this.emit({ type: 'connecting', channel: normalized });
        return payload;
    }

    /** @deprecated Legacy encoded-signal flow kept for backward compatibility tests. */
    async createHostOffer(roomKey, identity) {
        const payload = await this.createHostOfferPayload(roomKey, identity);
        const code = encodeSignal(payload.description, payload.evmAddress, payload.publicKey);
        this.emit({ type: 'local-offer', code, channel: this.currentChannel });
        return code;
    }

    /** @deprecated Legacy encoded-signal flow kept for backward compatibility tests. */
    async createAnswerFromOffer(roomKey, offerCode, identity) {
        const offerSignal = decodeSignal(offerCode);
        const offer = offerSignal.description;
        if (offer?.type !== 'offer') throw new Error('Offer code is invalid.');
        const answerPayload = await this.createAnswerPayloadFromRemoteOffer(roomKey, offerSignal, identity);
        this.peerPublicKey = offerSignal.publicKey || '';
        this.peerAddress = offerSignal.evmAddress || '';
        const code = encodeSignal(answerPayload.description, answerPayload.evmAddress, answerPayload.publicKey);
        this.emit({ type: 'local-answer', code, channel: this.currentChannel });

        if (this.peerAddress) {
            this.pushLocalSystemMessage(`🪪 Peer verified: ${this.peerAddress}`);
        }
        return code;
    }

    async createAnswerPayloadFromRemoteOffer(roomKey, offerPayload, identity) {
        const normalized = this.normalizeChannel(roomKey);
        if (!normalized) throw new Error('Room key is required.');
        const localIdentity = await this.requireAuthenticatedLocalIdentity(identity, 'answer');
        await this.leaveChannel();
        this.currentChannel = normalized;
        this.role = 'guest';
        this.identityAddress = localIdentity.evmAddress;
        this.messageIds.clear();
        this.createPeerConnection();
        const answerPayload = await this.createAnswerSignalPayloadFromOfferPayload(offerPayload, localIdentity);
        this._beginConnecting();
        this.emit({ type: 'connecting', channel: normalized });
        return answerPayload;
    }

    /** @deprecated Legacy encoded-signal flow kept for backward compatibility tests. */
    async applyAnswer(answerCode) {
        if (!this.peerConnection || this.role !== 'host') throw new Error('Create an offer first.');
        const answerSignal = decodeSignal(answerCode);
        const answer = answerSignal.description;
        if (answer?.type !== 'answer') throw new Error('Answer code is invalid.');
        verifySignalIdentity(answerSignal, 'answer');

        this.peerPublicKey = answerSignal.publicKey || '';
        this.peerAddress = answerSignal.evmAddress || '';

        if (this.peerAddress) {
            this.pushLocalSystemMessage(`🪪 Peer verified: ${this.peerAddress}`);
        }

        await this.peerConnection.setRemoteDescription(answer);
    }

    async createOfferSignalPayload(identity) {
        if (!this.peerConnection) throw new Error('Peer connection not initialized. Create host offer first.');
        const localIdentity = await this.requireAuthenticatedLocalIdentity(identity, 'host offer');
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        await this.waitForIceGathering(this.peerConnection);
        return {
            description: this.peerConnection.localDescription,
            evmAddress: localIdentity.evmAddress,
            publicKey: localIdentity.publicKey
        };
    }

    async applyRemoteOfferPayload(offerSignalPayload) {
        if (!offerSignalPayload?.description || offerSignalPayload?.description?.type !== 'offer') {
            throw new Error('Offer payload is invalid.');
        }
        if (!this.peerConnection) throw new Error('Peer connection is not initialized.');
        const offer = offerSignalPayload.description;
        verifySignalIdentity(offerSignalPayload, 'offer');
        if (this.persistentRoom) {
            if (!this._isCurrentPeer(offerSignalPayload)) throw new Error('Offer identity does not match this conversation.');
        } else {
            this.peerPublicKey = offerSignalPayload.publicKey || '';
            this.peerAddress = offerSignalPayload.evmAddress || '';
        }
        await this.peerConnection.setRemoteDescription(offer);
    }

    async createAnswerSignalPayloadFromOfferPayload(offerSignalPayload, identity) {
        if (!this.peerConnection) {
            this.createPeerConnection();
        }
        const localIdentity = await this.requireAuthenticatedLocalIdentity(identity, 'answer');
        await this.applyRemoteOfferPayload(offerSignalPayload);
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        await this.waitForIceGathering(this.peerConnection);
        // A room's peer was verified when they were saved; saying so again on
        // every direct link would only be noise.
        if (this.peerAddress && !this.persistentRoom) this.pushLocalSystemMessage(`🪪 Peer verified: ${this.peerAddress}`);
        return {
            description: this.peerConnection.localDescription,
            evmAddress: localIdentity.evmAddress,
            publicKey: localIdentity.publicKey
        };
    }

    async applyRemoteAnswerPayload(answerSignalPayload) {
        if (!this.peerConnection || this.role !== 'host') throw new Error('Create an offer first.');
        if (!answerSignalPayload?.description || answerSignalPayload.description.type !== 'answer') {
            throw new Error('Answer payload is invalid.');
        }
        verifySignalIdentity(answerSignalPayload, 'answer');
        if (this.persistentRoom) {
            if (!this._isCurrentPeer(answerSignalPayload)) throw new Error('Answer identity does not match this conversation.');
        } else {
            this.peerPublicKey = answerSignalPayload.publicKey || '';
            this.peerAddress = answerSignalPayload.evmAddress || '';
            if (this.peerAddress) this.pushLocalSystemMessage(`🪪 Peer verified: ${this.peerAddress}`);
        }
        await this.peerConnection.setRemoteDescription(answerSignalPayload.description);
    }

    async leaveChannel() {
        this._clearTransportTimers();
        this._closePeerConnection();
        this.currentChannel = '';
        this.currentPeerCount = 0;
        this.role = '';
        this.persistentRoom = false;
        this.peerPublicKey = '';
        this.peerAddress = '';
        this.messageIds.clear();

        this._setTransport(DM_TRANSPORT.DISCONNECTED, 'left');
        // Same dedupe as every other transition: leaving an already-idle
        // service must not emit a redundant state change.
        if (this.connectionState !== DM_CONNECTION.IDLE) {
            this.connectionState = DM_CONNECTION.IDLE;
            this.emit({ type: 'connection-state', state: DM_CONNECTION.IDLE, transport: this.transport, reason: 'left' });
        }
        this.emit({ type: 'peer-count', count: 0 });
        this.emit({ type: 'left' });
    }

    /**
     * A conversation is sendable when the DataChannel is open, or when the
     * Nostr relay fallback is armed.
     * @returns {boolean}
     */
    canSend() {
        return this.dataChannel?.readyState === 'open' || this.canUseNostrFallback;
    }

    sendChatMessage(text, identity) {
        if (!this.canSend()) throw new Error('Connection is not ready yet.');
        const clean = `${text || ''}`.trim();
        if (!clean) return;

        const payload = {
            type: 'chat',
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            text: clean,
            channel: this.currentChannel,
            from: identity?.address || this.identityAddress || 'anonymous',
            timestamp: new Date().toISOString()
        };

        return this.transmit(payload).then((sent) => {
            if (sent) this.handleInbound(payload, true);
            return sent;
        });
    }

    sendSystemMessage(kind, data, identity = null) {
        if (!this.canSend()) return;
        const payload = {
            type: 'system',
            id: `sys-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            channel: this.currentChannel,
            from: identity?.address || this.identityAddress || 'system',
            timestamp: new Date().toISOString(),
            data: { kind, ...data }
        };
        this.transmit(payload);
    }

    createPeerConnection() {
        if (typeof RTCPeerConnection !== 'function') {
            throw new Error('WebRTC is not available in this browser.');
        }

        const peer = new RTCPeerConnection(this.rtcConfig);
        this.peerConnection = peer;

        peer.ondatachannel = (event) => {
            this.dataChannel = event.channel;
            this.bindDataChannel(event.channel);
        };

        const syncConnectionState = () => {
            const state = `${peer.connectionState || peer.iceConnectionState || ''}`.toLowerCase();
            if (state === 'connected' || state === 'completed') {
                this.currentPeerCount = 1;
                if (this._disconnectTimer) {
                    clearTimeout(this._disconnectTimer);
                    this._disconnectTimer = null;
                }
                // If the peer connection recovered while the relay was carrying
                // the conversation, go straight back to the preferred transport.
                if (this.dataChannel?.readyState === 'open') this._promoteToWebrtc();
                this.emit({ type: 'peer-count', count: 1 });
                this.emit({ type: 'connected', channel: this.currentChannel });
            } else if (state === 'disconnected') {
                // Transient by nature — never fall back on this state alone.
                this.currentPeerCount = 0;
                this._scheduleDisconnectFallback();
                this.emit({ type: 'peer-count', count: 0 });
            } else if (state === 'failed' || state === 'closed') {
                this.currentPeerCount = 0;
                this._fallBack(`webrtc-${state}`);
                this.emit({ type: 'peer-count', count: 0 });
            }
        };

        peer.oniceconnectionstatechange = syncConnectionState;
        peer.onconnectionstatechange = syncConnectionState;
        return peer;
    }

    bindDataChannel(channel) {
        channel.onopen = () => {
            this.currentPeerCount = 1;
            this._promoteToWebrtc();
            this._syncConnectionState('datachannel-open');
            this.emit({ type: 'peer-count', count: 1 });
            this.emit({ type: 'connected', channel: this.currentChannel });
            this.pushLocalSystemMessage(
                this.persistentRoom
                    ? '🔗 Direct link open — messages now go browser to browser.'
                    : `Connected to room "${this.currentChannel}".`
            );
        };

        channel.onclose = () => {
            this.currentPeerCount = 0;
            const wasDirect = this.transport === DM_TRANSPORT.WEBRTC;
            this._fallBack('datachannel-closed');
            if (this.persistentRoom) {
                // The link was the only thing this peer connection was for;
                // the room goes on over Nostr without it.
                if (this.dataChannel === channel) this._closePeerConnection();
                if (wasDirect && this.transport === DM_TRANSPORT.NOSTR) {
                    this.pushLocalSystemMessage('Direct link closed — messages continue over Nostr.');
                }
            }
            this.emit({ type: 'peer-count', count: 0 });
            if (this.transport !== DM_TRANSPORT.NOSTR) this.emit({ type: 'disconnected' });
        };

        channel.onmessage = (event) => {
            void this.handleEncryptedWire(`${event?.data || ''}`, DM_TRANSPORT.WEBRTC);
        };
    }

    /**
     * The single inbound path for a Web25 wire payload, shared by the WebRTC
     * DataChannel and the Nostr relay fallback.
     *
     * Whatever the transport, the same rules apply: the peer identity must be
     * verified, the ciphertext must decrypt inside the wallet worker, and the
     * inner signature must check out before anything is rendered. A relay is
     * just another untrusted pipe.
     *
     * @param {string} raw hex ECIES payload
     * @param {string} [source]
     * @returns {Promise<boolean>} whether the message was accepted
     */
    async handleEncryptedWire(raw, source = DM_TRANSPORT.WEBRTC) {
        try {
            if (!this.hasVerifiedPeerIdentity()) {
                this.emit({ type: 'error', error: new Error('Cannot accept message: verified peer identity is required.') });
                return false;
            }
            const payload = await this.openEnvelope(raw, this.peerPublicKey);
            // Stable per-message ids mean the same message arriving over both
            // transports, or from several relays, is rendered exactly once.
            this.handleInbound(payload, false, source);
            return true;
        } catch (err) {
            this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
            return false;
        }
    }

    /**
     * Decrypt a Web25 wire payload inside the wallet worker and check its
     * signature against one specific peer key.
     *
     * The same check the open conversation applies, available for a message
     * from a saved contact whose conversation is not open: the key comes from
     * their contact record, so a message is only ever accepted from the person
     * it was saved as — never on what the message says about itself.
     *
     * @param {string} raw hex ECIES payload
     * @param {string} peerPublicKey the uncompressed ECIES key to verify against
     * @returns {Promise<any>} the verified payload
     */
    async openEnvelope(raw, peerPublicKey) {
        let envelope;
        try {
            envelope = await this._signer.eciesDecrypt(`${raw || ''}`);
        } catch (error) {
            // Surfaces the worker's own reason: a locked/expired session or a
            // ciphertext that failed to decrypt.
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Cannot decrypt message: ${reason}`);
        }
        const { plaintext, signature } = JSON.parse(envelope);
        if (typeof plaintext !== 'string' || typeof signature !== 'string') {
            throw new Error('Malformed encrypted message envelope.');
        }
        const valid = await verifySignature(plaintext, signature, peerPublicKey);
        if (!valid) throw new Error('Message signature verification failed: possible tampering.');
        return JSON.parse(plaintext);
    }

    /**
     * Inbound entry point for the Nostr relay fallback. The argument is the
     * same Web25 ciphertext the DataChannel would have carried.
     * @param {string} wire
     */
    receiveNostrEnvelope(wire) {
        return this.handleEncryptedWire(wire, DM_TRANSPORT.NOSTR);
    }

    /**
     * Serialize → sign → ECIES-encrypt, then hand the ciphertext to whichever
     * transport is available. The security model is identical either way: the
     * transport only ever sees the encrypted envelope.
     */
    async transmit(payload) {
        try {
            if (!this.canSend()) return false;
            if (!this.hasVerifiedPeerIdentity()) {
                this.emit({ type: 'error', error: new Error('Cannot send message: verified peer identity is required.') });
                return false;
            }
            const plaintext = JSON.stringify(payload);
            let signature;
            try {
                signature = await this._signer.signMessage(plaintext);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                this.emit({ type: 'error', error: new Error(`Cannot send message: ${reason}`) });
                return false;
            }
            const envelope = JSON.stringify({ plaintext, signature });
            const wire = await eciesEncrypt(envelope, this.peerPublicKey);
            return await this._deliver(wire);
        } catch (err) {
            this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
            return false;
        }
    }

    /**
     * WebRTC first, always. The relay is used only when the DataChannel is not
     * open — never as a silent parallel path.
     * @param {string} wire
     * @returns {Promise<boolean>}
     */
    async _deliver(wire) {
        if (this.dataChannel?.readyState === 'open') {
            this.dataChannel.send(wire);
            if (this.transport !== DM_TRANSPORT.WEBRTC) this._promoteToWebrtc();
            return true;
        }

        if (!this.canUseNostrFallback) return false;

        try {
            const sent = await this._nostrFallback.send(wire);
            if (sent) {
                if (this.transport !== DM_TRANSPORT.NOSTR) this._setTransport(DM_TRANSPORT.NOSTR, 'webrtc-unavailable');
                return true;
            }
            this.emit({ type: 'error', error: new Error('No Nostr relay accepted the message.') });
            return false;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.emit({ type: 'error', error: new Error(`Relay fallback failed: ${reason}`) });
            return false;
        }
    }

    handleInbound(payload, isLocal = false, source = '') {
        if (!payload || payload.channel !== this.currentChannel) return;
        // Stable message ids: a duplicate arriving over the other transport, or
        // from a second relay, is dropped here rather than rendered twice.
        if (payload.id && this.messageIds.has(payload.id)) return;
        if (payload.id) this.messageIds.add(payload.id);

        if (payload.type === 'chat') this.emit({ type: 'message', message: payload, local: isLocal, source });
        if (payload.type === 'system') this.emit({ type: 'system', payload, local: isLocal, source });

        if (payload.type === 'file-info') {
            this._beginFileTransfer(payload, isLocal);
        }

        if (payload.type === 'file-chunk') {
            // A DataChannel is ordered, so the announcement always arrived
            // first there. Relays are not: each chunk is its own published
            // event, and one can be delivered before the `file-info` that
            // introduced it. Dropping those chunks meant a transfer that could
            // never reach its size and hung forever, so a chunk carries enough
            // to open the transfer by itself.
            const info = this._beginFileTransfer(payload, isLocal);
            const buf = this._fileBuffers?.[payload.fileId];
            if (!buf || !info) return;

            const bytes = Uint8Array.from(atob(payload.chunk), (c) => c.charCodeAt(0));
            // Count each index once: the same chunk arriving from two relays
            // must not push the byte count past the real size.
            if (!buf.received.has(payload.chunkIndex)) {
                buf.chunks[payload.chunkIndex] = bytes;
                buf.received.add(payload.chunkIndex);
                buf.receivedSize += bytes.length;
            }
            if (Number.isInteger(payload.totalChunks) && payload.totalChunks > 0) {
                buf.totalChunks = payload.totalChunks;
            }

            // The name and size ride along: a progress event is the only thing
            // the receiving UI has between "incoming" and "ready", and over the
            // relay that gap is seconds long rather than instant.
            this.emit({
                type: 'file-progress',
                fileId: payload.fileId,
                fileName: info.fileName,
                fileSize: info.fileSize,
                received: buf.receivedSize,
                total: info.fileSize
            });

            // Complete means every chunk is here, not merely enough bytes: with
            // out-of-order delivery a byte count can reach the total while an
            // earlier index is still missing, and assembling then would write a
            // hole into the file.
            const complete = buf.totalChunks
                ? buf.received.size === buf.totalChunks
                : info.fileSize > 0 && buf.receivedSize >= info.fileSize;
            if (!complete) return;

            const blob = new Blob(buf.chunks);
            const url = URL.createObjectURL(blob);
            this.emit({ type: 'file-ready', fileId: payload.fileId, fileName: info.fileName, url });
            delete this._fileBuffers[payload.fileId];
            delete this._fileInfos[payload.fileId];
        }
    }

    /**
     * Open a transfer, from whichever of its events arrived first.
     *
     * Called for both `file-info` and `file-chunk`, and deliberately does not
     * reset an open transfer: a `file-info` that overtakes its own chunks would
     * otherwise throw away everything already buffered.
     *
     * @param {any} payload
     * @param {boolean} isLocal
     * @returns {{ fileName: string, fileSize: number }|null}
     */
    _beginFileTransfer(payload, isLocal = false) {
        if (!this._fileBuffers) this._fileBuffers = {};
        if (!this._fileInfos) this._fileInfos = {};

        const existing = this._fileInfos[payload.fileId];
        if (existing) {
            // A late announcement can still fill in what a chunk could not.
            if (!existing.fileName && payload.fileName) existing.fileName = payload.fileName;
            if (!existing.fileSize && payload.fileSize) existing.fileSize = Number(payload.fileSize) || 0;
            return existing;
        }

        const fileSize = Number(payload.fileSize) || 0;
        if (!payload.fileName && !fileSize) return null;

        const info = { fileName: `${payload.fileName || 'file'}`, fileSize };
        this._fileInfos[payload.fileId] = info;
        this._fileBuffers[payload.fileId] = {
            chunks: [],
            received: new Set(),
            receivedSize: 0,
            totalChunks: Number.isInteger(payload.totalChunks) && payload.totalChunks > 0 ? payload.totalChunks : 0
        };
        this.emit({
            type: 'file-incoming',
            fileId: payload.fileId,
            fileName: info.fileName,
            fileSize: info.fileSize,
            local: isLocal
        });
        return info;
    }

    /**
     * Send a File object in chunks, over whichever transport the conversation
     * is actually using.
     *
     * This used to require an open DataChannel and refuse everything else, on
     * the grounds that chunking over public relays would be abusive. Refusing
     * outright turned out to be the wrong shape of that argument: a
     * conversation carried by the relay is a working conversation, and a file
     * that cannot be sent in it is a feature that silently stops existing for
     * the people whose WebRTC never connects — exactly the people with the
     * least control over why.
     *
     * So the relay path exists, with the restraint expressed as limits rather
     * than as a refusal: smaller chunks that survive the NIP-59 layers, a cap
     * on the total size, and a pause between chunks. Everything else is
     * identical — same envelope, same per-chunk signature, same ECIES — because
     * `transmit()` already treats the transport as a detail. WebRTC still wins
     * whenever it is up; the relay is what happens instead of nothing.
     *
     * @param {File} file
     * @param {{ address?: string } | null} identity
     */
    async sendFile(file, identity) {
        if (!this.canSend()) throw new Error('Connection is not ready yet.');

        const overRelay = this.dataChannel?.readyState !== 'open';
        const CHUNK_SIZE = overRelay ? this._transportConfig.RELAY_FILE_CHUNK_BYTES : 16 * 1024;

        if (overRelay && file.size > this._transportConfig.RELAY_FILE_MAX_BYTES) {
            const limitMb = Math.round(this._transportConfig.RELAY_FILE_MAX_BYTES / (1024 * 1024));
            throw new Error(
                `This conversation is running over public relays, which carry files up to ${limitMb} MB. ` +
                    'Wait for the direct connection to come up, or send something smaller.'
            );
        }

        const fileId = generateHexKey(8);
        const from = identity?.address || this.identityAddress || 'anonymous';

        const infoPayload = {
            type: 'file-info',
            id: `fi-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            channel: this.currentChannel,
            from,
            timestamp: new Date().toISOString(),
            fileId,
            fileName: file.name,
            fileSize: file.size
        };
        this.handleInbound(infoPayload, true);
        if (!(await this.transmit(infoPayload))) {
            throw new Error('The file could not be announced to the peer.');
        }

        this.emit({ type: 'file-send-start', fileId, fileName: file.name, fileSize: file.size, overRelay });

        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const start = chunkIndex * CHUNK_SIZE;
            const slice = file.slice(start, start + CHUNK_SIZE);
            const buffer = await slice.arrayBuffer();
            const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
            const chunkPayload = {
                type: 'file-chunk',
                id: `fc-${Date.now()}-${chunkIndex}-${Math.random().toString(16).slice(2)}`,
                channel: this.currentChannel,
                from,
                timestamp: new Date().toISOString(),
                fileId,
                chunkIndex,
                // Enough to open the transfer on its own. Relays publish each
                // chunk as its own event and do not promise to deliver them in
                // order, so a chunk that arrives before the announcement has to
                // be usable rather than dropped.
                fileName: file.name,
                fileSize: file.size,
                totalChunks,
                chunk: b64
            };
            // A chunk that no transport accepted leaves the receiver with a
            // gap it can never fill, and it reassembles by total size — so the
            // transfer stops here and says so, rather than hanging at 94%.
            if (!(await this.transmit(chunkPayload))) {
                this.emit({ type: 'file-send-error', fileId, chunkIndex });
                throw new Error(`The file stopped sending at chunk ${chunkIndex + 1} of ${totalChunks}.`);
            }
            this.emit({
                type: 'file-send-progress',
                fileId,
                sent: Math.min((chunkIndex + 1) * CHUNK_SIZE, file.size),
                total: file.size,
                overRelay
            });

            if (overRelay && chunkIndex + 1 < totalChunks) {
                await new Promise((resolve) => setTimeout(resolve, this._transportConfig.RELAY_FILE_CHUNK_PAUSE_MS));
            }
        }

        this.emit({ type: 'file-send-done', fileId });
    }

    pushLocalSystemMessage(text) {
        this.handleInbound(
            {
                type: 'chat',
                id: `system-${Date.now()}`,
                text,
                channel: this.currentChannel,
                from: 'system',
                timestamp: new Date().toISOString()
            },
            true
        );
    }

    waitForIceGathering(peer) {
        if (peer.iceGatheringState === 'complete') return Promise.resolve();
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                peer.removeEventListener?.('icegatheringstatechange', onStateChange);
                resolve();
            }, 4000);

            const onStateChange = () => {
                if (peer.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    peer.removeEventListener?.('icegatheringstatechange', onStateChange);
                    resolve();
                }
            };

            peer.addEventListener?.('icegatheringstatechange', onStateChange);
        });
    }

    normalizeChannel(value) {
        return `${value || ''}`.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 40);
    }
}
