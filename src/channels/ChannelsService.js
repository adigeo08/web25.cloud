// @ts-check

import { eciesEncrypt, verifySignature, evmAddressFromPublicKey } from './ecies.js';
import { createLocalWalletSigner } from '../auth/LocalWalletService.js';

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

export default class ChannelsService {
    /**
     * @param {{ rtcConfig?: RTCConfiguration, signer?: WalletSigner|null }} [options]
     */
    constructor({ rtcConfig = DEFAULT_RTC_CONFIG, signer = null } = {}) {
        this.rtcConfig = rtcConfig;
        this.peerConnection = null;
        this.dataChannel = null;
        this.currentChannel = '';
        this.currentPeerCount = 0;
        this.messageIds = new Set();
        this.listeners = new Set();
        this.identityAddress = 'anonymous';
        this.role = '';
        this.peerPublicKey = '';
        this.peerAddress = '';
        this._fileBuffers = {};
        this._fileInfos = {};
        /** @type {WalletSigner} */
        this._signer = signer || createLocalWalletSigner();
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
        this.peerPublicKey = offerSignalPayload.publicKey || '';
        this.peerAddress = offerSignalPayload.evmAddress || '';
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
        if (this.peerAddress) this.pushLocalSystemMessage(`🪪 Peer verified: ${this.peerAddress}`);
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
        this.peerPublicKey = answerSignalPayload.publicKey || '';
        this.peerAddress = answerSignalPayload.evmAddress || '';
        if (this.peerAddress) this.pushLocalSystemMessage(`🪪 Peer verified: ${this.peerAddress}`);
        await this.peerConnection.setRemoteDescription(answerSignalPayload.description);
    }

    async leaveChannel() {
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
        this.currentChannel = '';
        this.currentPeerCount = 0;
        this.role = '';
        this.peerPublicKey = '';
        this.peerAddress = '';
        this.messageIds.clear();

        this.emit({ type: 'peer-count', count: 0 });
        this.emit({ type: 'left' });
    }

    sendChatMessage(text, identity) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') throw new Error('Connection is not ready yet.');
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
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') return;
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
                this.emit({ type: 'peer-count', count: 1 });
                this.emit({ type: 'connected', channel: this.currentChannel });
            } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                this.currentPeerCount = 0;
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
            this.emit({ type: 'peer-count', count: 1 });
            this.emit({ type: 'connected', channel: this.currentChannel });
            this.pushLocalSystemMessage(`Connected to room "${this.currentChannel}".`);
        };

        channel.onclose = () => {
            this.currentPeerCount = 0;
            this.emit({ type: 'peer-count', count: 0 });
            this.emit({ type: 'disconnected' });
        };

        channel.onmessage = async (event) => {
            try {
                if (!this.hasVerifiedPeerIdentity()) {
                    this.emit({ type: 'error', error: new Error('Cannot accept message: verified peer identity is required.') });
                    return;
                }
                const raw = `${event?.data || ''}`;
                let envelope;
                try {
                    envelope = await this._signer.eciesDecrypt(raw);
                } catch (error) {
                    // Surfaces the worker's own reason: a locked/expired session
                    // or a ciphertext that failed to decrypt.
                    const reason = error instanceof Error ? error.message : String(error);
                    this.emit({ type: 'error', error: new Error(`Cannot decrypt message: ${reason}`) });
                    return;
                }
                const { plaintext, signature } = JSON.parse(envelope);
                if (typeof plaintext !== 'string' || typeof signature !== 'string') {
                    throw new Error('Malformed encrypted message envelope.');
                }
                const valid = await verifySignature(plaintext, signature, this.peerPublicKey);
                if (!valid) {
                    this.emit({ type: 'error', error: new Error('Message signature verification failed: possible tampering.') });
                    return;
                }
                const payload = JSON.parse(plaintext);
                this.handleInbound(payload, false);
            } catch (err) {
                this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
            }
        };
    }

    async transmit(payload) {
        try {
            if (!this.dataChannel || this.dataChannel.readyState !== 'open') return false;
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
            this.dataChannel.send(wire);
            return true;
        } catch (err) {
            this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
            return false;
        }
    }

    handleInbound(payload, isLocal = false) {
        if (!payload || payload.channel !== this.currentChannel) return;
        if (payload.id && this.messageIds.has(payload.id)) return;
        if (payload.id) this.messageIds.add(payload.id);

        if (payload.type === 'chat') this.emit({ type: 'message', message: payload, local: isLocal });
        if (payload.type === 'system') this.emit({ type: 'system', payload, local: isLocal });

        if (payload.type === 'file-info') {
            if (!this._fileBuffers) this._fileBuffers = {};
            if (!this._fileInfos) this._fileInfos = {};
            this._fileInfos[payload.fileId] = { fileName: payload.fileName, fileSize: payload.fileSize };
            this._fileBuffers[payload.fileId] = { chunks: [], receivedSize: 0 };
            this.emit({ type: 'file-incoming', fileId: payload.fileId, fileName: payload.fileName, fileSize: payload.fileSize, local: isLocal });
        }

        if (payload.type === 'file-chunk') {
            const buf = this._fileBuffers?.[payload.fileId];
            const info = this._fileInfos?.[payload.fileId];
            if (!buf || !info) return;
            const bytes = Uint8Array.from(atob(payload.chunk), (c) => c.charCodeAt(0));
            buf.chunks[payload.chunkIndex] = bytes;
            buf.receivedSize += bytes.length;
            this.emit({ type: 'file-progress', fileId: payload.fileId, received: buf.receivedSize, total: info.fileSize });
            if (buf.receivedSize >= info.fileSize) {
                const blob = new Blob(buf.chunks);
                const url = URL.createObjectURL(blob);
                this.emit({ type: 'file-ready', fileId: payload.fileId, fileName: info.fileName, url });
                delete this._fileBuffers[payload.fileId];
                delete this._fileInfos[payload.fileId];
            }
        }
    }

    /**
     * Send a File object over the DataChannel in chunks.
     * @param {File} file
     * @param {{ address?: string } | null} identity
     */
    async sendFile(file, identity) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') throw new Error('Connection is not ready yet.');

        const CHUNK_SIZE = 16 * 1024;
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
        await this.transmit(infoPayload);

        this.emit({ type: 'file-send-start', fileId, fileName: file.name, fileSize: file.size });

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
                chunk: b64
            };
            await this.transmit(chunkPayload);
            this.emit({ type: 'file-send-progress', fileId, sent: Math.min((chunkIndex + 1) * CHUNK_SIZE, file.size), total: file.size });
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
