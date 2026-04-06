// @ts-check

import { eciesEncrypt, eciesDecrypt, signMessage, verifySignature, evmAddressFromPublicKey, getPublicKeyFromPrivateKey } from './ecies.js';
import { getUnlockedPrivateKey } from '../auth/LocalWalletService.js';

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

export default class ChannelsService {
    /**
     * @param {{ rtcConfig?: RTCConfiguration, getPrivateKey?: (() => string|null) }} [options]
     */
    constructor({ rtcConfig = DEFAULT_RTC_CONFIG, getPrivateKey = null } = {}) {
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
        /** @type {() => string|null} */
        this._getPrivateKey = getPrivateKey || getUnlockedPrivateKey;
    }

    onUpdate(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event) {
        this.listeners.forEach((listener) => listener(event));
    }

    async createHostOffer(roomKey, identity) {
        const normalized = this.normalizeChannel(roomKey);
        if (!normalized) throw new Error('Room key is required.');

        await this.leaveChannel();
        this.currentChannel = normalized;
        this.role = 'host';
        this.identityAddress = identity?.address || 'anonymous';
        this.peerPublicKey = '';
        this.peerAddress = '';
        this.messageIds.clear();

        const privKey = this._getPrivateKey();
        const ownPublicKey = privKey ? getPublicKeyFromPrivateKey(privKey) : null;

        const peer = this.createPeerConnection();
        const channel = peer.createDataChannel('web25-direct-messenger');
        this.bindDataChannel(channel);
        this.dataChannel = channel;

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await this.waitForIceGathering(peer);

        const code = encodeSignal(peer.localDescription, identity?.address || null, ownPublicKey);
        this.emit({ type: 'local-offer', code, channel: normalized });
        this.emit({ type: 'connecting', channel: normalized });
        return code;
    }

    async createAnswerFromOffer(roomKey, offerCode, identity) {
        const normalized = this.normalizeChannel(roomKey);
        if (!normalized) throw new Error('Room key is required.');
        const offerSignal = decodeSignal(offerCode);
        const offer = offerSignal.description;
        if (offer?.type !== 'offer') throw new Error('Offer code is invalid.');

        // Verify peer identity embedded in the offer signal
        if (offerSignal.publicKey && offerSignal.evmAddress) {
            const derivedAddress = evmAddressFromPublicKey(offerSignal.publicKey);
            if (derivedAddress.toLowerCase() !== offerSignal.evmAddress.toLowerCase()) {
                throw new Error('Peer identity verification failed: public key does not match claimed address.');
            }
        }

        await this.leaveChannel();
        this.currentChannel = normalized;
        this.role = 'guest';
        this.identityAddress = identity?.address || 'anonymous';
        this.peerPublicKey = offerSignal.publicKey || '';
        this.peerAddress = offerSignal.evmAddress || '';
        this.messageIds.clear();

        const privKey = this._getPrivateKey();
        const ownPublicKey = privKey ? getPublicKeyFromPrivateKey(privKey) : null;

        const peer = this.createPeerConnection();
        await peer.setRemoteDescription(offer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await this.waitForIceGathering(peer);

        const code = encodeSignal(peer.localDescription, identity?.address || null, ownPublicKey);
        this.emit({ type: 'local-answer', code, channel: normalized });
        this.emit({ type: 'connecting', channel: normalized });

        if (this.peerAddress) {
            this.pushLocalSystemMessage(`🪪 Peer verified: ${this.peerAddress}`);
        }
        return code;
    }

    async applyAnswer(answerCode) {
        if (!this.peerConnection || this.role !== 'host') throw new Error('Create an offer first.');
        const answerSignal = decodeSignal(answerCode);
        const answer = answerSignal.description;
        if (answer?.type !== 'answer') throw new Error('Answer code is invalid.');

        // Verify peer identity embedded in the answer signal
        if (answerSignal.publicKey && answerSignal.evmAddress) {
            const derivedAddress = evmAddressFromPublicKey(answerSignal.publicKey);
            if (derivedAddress.toLowerCase() !== answerSignal.evmAddress.toLowerCase()) {
                this.emit({ type: 'error', error: new Error('Peer identity verification failed: public key does not match claimed address.') });
                throw new Error('Peer identity verification failed: public key does not match claimed address.');
            }
        }

        this.peerPublicKey = answerSignal.publicKey || '';
        this.peerAddress = answerSignal.evmAddress || '';

        if (this.peerAddress) {
            this.pushLocalSystemMessage(`🪪 Peer verified: ${this.peerAddress}`);
        }

        await this.peerConnection.setRemoteDescription(answer);
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

        this.handleInbound(payload, true);
        return this.transmit(payload);
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
                const raw = `${event?.data || ''}`;
                let plaintext;

                if (this.peerPublicKey) {
                    const ownPrivKey = this._getPrivateKey();
                    if (!ownPrivKey) {
                        this.emit({ type: 'error', error: new Error('Cannot decrypt message: wallet is locked.') });
                        return;
                    }
                    const envelope = await eciesDecrypt(raw, ownPrivKey);
                    const { plaintext: pt, signature } = JSON.parse(envelope);

                    const valid = await verifySignature(pt, signature, this.peerPublicKey);
                    if (!valid) {
                        this.emit({ type: 'error', error: new Error('Message signature verification failed: possible tampering.') });
                        return;
                    }
                    plaintext = pt;
                } else {
                    plaintext = raw;
                }

                const payload = JSON.parse(plaintext);
                this.handleInbound(payload, false);
            } catch (_) {}
        };
    }

    async transmit(payload) {
        try {
            if (!this.dataChannel || this.dataChannel.readyState !== 'open') return;
            const plaintext = JSON.stringify(payload);

            let wire;
            if (this.peerPublicKey) {
                const ownPrivKey = this._getPrivateKey();
                if (!ownPrivKey) {
                    this.emit({ type: 'error', error: new Error('Cannot send message: wallet is locked.') });
                    return;
                }
                const signature = await signMessage(plaintext, ownPrivKey);
                const envelope = JSON.stringify({ plaintext, signature });
                wire = await eciesEncrypt(envelope, this.peerPublicKey);
            } else {
                wire = plaintext;
            }

            this.dataChannel.send(wire);
        } catch (_) {}
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
