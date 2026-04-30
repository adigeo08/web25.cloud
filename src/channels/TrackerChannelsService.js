// @ts-check

import { eciesEncrypt, eciesDecrypt, signMessage, verifySignature, evmAddressFromPublicKey, getPublicKeyFromPrivateKey } from './ecies.js';
import { getUnlockedPrivateKey } from '../auth/LocalWalletService.js';

const MSG_PREFIX = 'WEB25DM:';
const HANDSHAKE_TIMEOUT_MS = 10000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const msgPrefixBytes = textEncoder.encode(MSG_PREFIX);

/**
 * Derive a deterministic SHA-1 infohash from a room key.
 * Namespace-prefixed to avoid collisions with real torrents.
 * @param {string} roomKey
 * @returns {Promise<string>}
 */
async function deriveRoomInfohash(roomKey) {
    const input = `web25-dm-v1:${roomKey.trim().toLowerCase()}`;
    const encoded = new TextEncoder().encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-1', encoded);
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

function generateHexKey(byteLength = 8) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Tracker-based Direct Messenger service.
 * Uses the existing WebTorrent client (wtClient) for peer discovery via WSS tracker.
 * Connections are strictly 1-to-1 and E2E encrypted with ECIES on the peer's EVM public key.
 */
export default class TrackerChannelsService {
    /**
     * @param {{ wtClient: any, trackers?: string[], getPrivateKey?: (() => string|null) }} [options]
     */
    constructor({ wtClient, trackers, getPrivateKey = null } = {}) {
        this.wtClient = wtClient;
        this.trackers = trackers || [];
        /** @type {() => string|null} */
        this._getPrivateKey = getPrivateKey || getUnlockedPrivateKey;

        // State identical to ChannelsService
        this.currentChannel = '';
        this.currentPeerCount = 0;
        this.messageIds = new Set();
        this.listeners = new Set();
        this.identityAddress = 'anonymous';
        this.peerPublicKey = '';
        this.peerAddress = '';
        this._fileBuffers = {};
        this._fileInfos = {};

        // State specific to TrackerChannelsService
        this._torrent = null;
        this._peerConn = null; // Active bittorrent wire
        this._dc = null;       // Active wire transport used for send/receive
        this._handshakeDone = false;
        this._incomingBuffer = new Uint8Array(0);
        this._incomingOffset = 0;
        this._handshakeTimer = null;
    }

    onUpdate(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event) {
        this.listeners.forEach((listener) => listener(event));
    }

    normalizeChannel(value) {
        return `${value || ''}`.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 40);
    }

    /**
     * Join a room by deriving an infohash from the room key and adding a virtual magnet to the
     * WebTorrent client. Peer discovery and signaling happen automatically via the WSS tracker.
     * @param {string} roomKey
     * @param {{ address?: string } | null} identity
     */
    async joinRoom(roomKey, identity) {
        await this.leaveChannel();

        const normalized = this.normalizeChannel(roomKey);
        if (!normalized) throw new Error('Room key is required.');

        this.currentChannel = normalized;
        this.identityAddress = identity?.address || 'anonymous';
        this.messageIds.clear();

        const infohash = await deriveRoomInfohash(normalized);
        const trackerParam = this.trackers[0] ? `&tr=${encodeURIComponent(this.trackers[0])}` : '';
        const magnetURI = `magnet:?xt=urn:btih:${infohash}${trackerParam}`;

        this._torrent = this.wtClient.add(magnetURI);
        this._torrent.on('wire', (wire) => this._onWire(wire));
        this._torrent.on('warning', (warning) => this.emit({ type: 'warning', warning }));
        this._torrent.on('error', (error) => this.emit({ type: 'error', error }));

        this.emit({ type: 'connecting', channel: this.currentChannel });
    }

    /**
     * Called when WebTorrent establishes a bittorrent wire with a peer.
     * Enforces strict 1-to-1: the second peer to connect is rejected immediately.
     * @param {any} wire
     */
    _onWire(wire) {
        if (this._peerConn) {
            try { wire.destroy(); } catch (_) {}
            return;
        }

        this.emit({ type: 'debug', message: 'wire created' });
        this._peerConn = wire;
        if (!wire || typeof wire.write !== 'function' || typeof wire.on !== 'function') {
            try { wire?.destroy?.(); } catch (_) {}
            this._peerConn = null;
            this.emit({ type: 'error', error: new Error('Wire transport is not usable (missing write/on API).') });
            return;
        }

        this._dc = wire;
        this._incomingBuffer = new Uint8Array(0);
        this._incomingOffset = 0;
        this._setupConnection(wire);
    }

    decodeRawChunk(rawData) {
        if (typeof rawData === 'string') return textEncoder.encode(rawData);
        if (rawData instanceof ArrayBuffer) return new Uint8Array(rawData);
        if (ArrayBuffer.isView(rawData)) return new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength);
        return new Uint8Array(rawData || []);
    }

    encodeFrame(payload) {
        const payloadByteLength = textEncoder.encode(payload).length;
        return `${MSG_PREFIX}${payloadByteLength}:${payload}`;
    }

    _indexOfBytes(buffer, needle, from = 0) {
        if (!needle || needle.length === 0) return -1;
        for (let i = from; i <= buffer.length - needle.length; i++) {
            let found = true;
            for (let j = 0; j < needle.length; j++) {
                if (buffer[i + j] !== needle[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return i;
        }
        return -1;
    }

    _appendIncomingBytes(chunkBytes) {
        const unread = this._incomingBuffer.subarray(this._incomingOffset);
        const next = new Uint8Array(unread.length + chunkBytes.length);
        next.set(unread, 0);
        next.set(chunkBytes, unread.length);
        this._incomingBuffer = next;
        this._incomingOffset = 0;
    }

    pushAndExtractFrames(chunkBytes) {
        this._appendIncomingBytes(chunkBytes);
        const frames = [];

        while (true) {
            const prefixIndex = this._indexOfBytes(this._incomingBuffer, msgPrefixBytes, this._incomingOffset);
            if (prefixIndex < 0) {
                this._incomingBuffer = new Uint8Array(0);
                this._incomingOffset = 0;
                break;
            }
            if (prefixIndex > this._incomingOffset) {
                this._incomingOffset = prefixIndex;
            }

            const lenStart = this._incomingOffset + msgPrefixBytes.length;
            const colonByte = 58; // ':'
            let colonIndex = -1;
            for (let i = lenStart; i < this._incomingBuffer.length; i++) {
                if (this._incomingBuffer[i] === colonByte) {
                    colonIndex = i;
                    break;
                }
            }
            if (colonIndex < 0) break;

            const lenRaw = textDecoder.decode(this._incomingBuffer.subarray(lenStart, colonIndex));
            const frameLen = Number.parseInt(lenRaw, 10);
            if (!Number.isFinite(frameLen) || frameLen < 0) {
                this.emit({ type: 'debug', message: `parse fail: invalid frame length "${lenRaw}"` });
                const nextPrefix = this._indexOfBytes(this._incomingBuffer, msgPrefixBytes, this._incomingOffset + 1);
                if (nextPrefix >= 0) {
                    this._incomingOffset = nextPrefix;
                } else {
                    this._incomingBuffer = new Uint8Array(0);
                    this._incomingOffset = 0;
                }
                continue;
            }

            const frameStart = colonIndex + 1;
            const frameEnd = frameStart + frameLen;
            if (this._incomingBuffer.length < frameEnd) break;

            const candidateFrameBytes = this._incomingBuffer.subarray(frameStart, frameEnd);
            const candidateFrame = textDecoder.decode(candidateFrameBytes);
            frames.push(candidateFrame);
            this._incomingOffset = frameEnd;
            if (this._incomingOffset >= this._incomingBuffer.length) {
                this._incomingBuffer = new Uint8Array(0);
                this._incomingOffset = 0;
            }
        }

        return frames;
    }

    /**
     * Set up data listeners and send the EVM identity hello on the active wire transport.
     * @param {any} wire
     */
    async _setupConnection(wire) {
        const privKey = this._getPrivateKey();
        if (!privKey) {
            this.emit({ type: 'error', error: new Error('Cannot start Direct Messenger handshake: wallet is locked.') });
            try { wire.destroy?.(); } catch (_) {}
            this._peerConn = null;
            this._dc = null;
            return;
        }

        const ownPublicKey = getPublicKeyFromPrivateKey(privKey);
        const nonce = generateHexKey(16);
        const signature = await signMessage(nonce, privKey);

        const hello = {
            type: 'web25-dm-hello',
            evmAddress: this.identityAddress,
            publicKey: ownPublicKey,
            nonce,
            signature
        };

        wire.on('data', async (rawData) => {
            const raw = this.decodeRawChunk(rawData);
            this.emit({ type: 'debug', message: `raw chunk received (${raw.length} bytes)` });
            const frames = this.pushAndExtractFrames(raw);

            for (const frame of frames) {
                this.emit({ type: 'debug', message: `frame decoded (${frame.length} chars)` });
                try {
                    if (!this._handshakeDone) {
                        const msg = JSON.parse(frame);
                        if (msg.type === 'web25-dm-hello') {
                            this.emit({ type: 'debug', message: 'hello received' });
                            await this._handleHello(msg, wire);
                        }
                        continue;
                    }

                    // Regular message — decrypt and verify if ECIES is active
                    let plaintext;
                    if (this.peerPublicKey) {
                        const ownPrivKey = this._getPrivateKey();
                        if (!ownPrivKey) {
                            this.emit({ type: 'error', error: new Error('Cannot decrypt message: wallet is locked.') });
                            continue;
                        }
                        const envelope = await eciesDecrypt(frame, ownPrivKey);
                        const { plaintext: pt, signature: sig } = JSON.parse(envelope);
                        const valid = await verifySignature(pt, sig, this.peerPublicKey);
                        if (!valid) {
                            this.emit({ type: 'error', error: new Error('Message signature verification failed: possible tampering.') });
                            continue;
                        }
                        plaintext = pt;
                    } else {
                        plaintext = frame;
                    }

                    const payload = JSON.parse(plaintext);
                    this.handleInbound(payload, false);
                } catch (err) {
                    this.emit({ type: 'debug', message: `parse fail: ${err instanceof Error ? err.message : String(err)}` });
                    this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
                }
            }
        });

        wire.on('close', () => {
            this.currentPeerCount = 0;
            this.emit({ type: 'peer-count', count: 0 });
            this.emit({ type: 'disconnected' });
            this._handshakeDone = false;
            this.peerPublicKey = '';
            this.peerAddress = '';
            this._dc = null;
            this._peerConn = null;
            this._incomingBuffer = new Uint8Array(0);
            this._incomingOffset = 0;
            this._clearHandshakeTimer();
        });

        try {
            wire.write(textEncoder.encode(this.encodeFrame(JSON.stringify(hello))));
            this.emit({ type: 'debug', message: 'hello sent' });
        } catch (err) {
            this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        }
        this._startHandshakeTimer();

        wire.on('error', (err) => {
            this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        });
    }

    /**
     * Handle the EVM identity hello from the remote peer.
     * Verifies publicKey ↔ evmAddress and signature possession.
     * @param {{ type: string, evmAddress: string, publicKey: string, nonce: string, signature: string }} msg
     * @param {any} wire
     */
    async _handleHello(msg, wire) {
        if (!msg.publicKey || !msg.evmAddress) {
            const err = new Error('Peer hello missing publicKey or evmAddress.');
            this.emit({ type: 'error', error: err });
            try { wire.destroy?.(); } catch (_) {}
            this._handshakeDone = false;
            this._peerConn = null;
            this._dc = null;
            this.peerPublicKey = '';
            this.peerAddress = '';
            this._incomingBuffer = new Uint8Array(0);
            this._incomingOffset = 0;
            this._clearHandshakeTimer();
            return;
        }

        const derivedAddress = evmAddressFromPublicKey(msg.publicKey);
        if (derivedAddress.toLowerCase() !== msg.evmAddress.toLowerCase()) {
            const err = new Error('Peer identity verification failed: public key does not match claimed address.');
            this.emit({ type: 'error', error: err });
            try { wire.destroy?.(); } catch (_) {}
            this._handshakeDone = false;
            this._peerConn = null;
            this._dc = null;
            this.peerPublicKey = '';
            this.peerAddress = '';
            this._incomingBuffer = new Uint8Array(0);
            this._incomingOffset = 0;
            this._clearHandshakeTimer();
            return;
        }

        if (!msg.signature || !msg.nonce) {
            const err = new Error('Peer hello missing signature or nonce: identity cannot be verified.');
            this.emit({ type: 'error', error: err });
            try { wire.destroy?.(); } catch (_) {}
            this._handshakeDone = false;
            this._peerConn = null;
            this._dc = null;
            this.peerPublicKey = '';
            this.peerAddress = '';
            this._incomingBuffer = new Uint8Array(0);
            this._incomingOffset = 0;
            this._clearHandshakeTimer();
            return;
        }

        const valid = await verifySignature(msg.nonce, msg.signature, msg.publicKey);
        if (!valid) {
            const err = new Error('Peer hello signature verification failed.');
            this.emit({ type: 'error', error: err });
            try { wire.destroy?.(); } catch (_) {}
            this._handshakeDone = false;
            this._peerConn = null;
            this._dc = null;
            this.peerPublicKey = '';
            this.peerAddress = '';
            this._incomingBuffer = new Uint8Array(0);
            this._incomingOffset = 0;
            this._clearHandshakeTimer();
            return;
        }

        this.peerPublicKey = msg.publicKey;
        this.peerAddress = msg.evmAddress;
        this._handshakeDone = true;
        this.currentPeerCount = 1;

        this.emit({ type: 'peer-count', count: 1 });
        this.emit({ type: 'connected', channel: this.currentChannel });
        this.emit({ type: 'debug', message: 'peer verified' });
        this.emit({ type: 'debug', message: 'connected' });
        this._clearHandshakeTimer();
        this.pushLocalSystemMessage(`Connected to room "${this.currentChannel}".`);

        if (this.peerAddress) {
            this.pushLocalSystemMessage(`🪪 Peer verified: ${this.peerAddress}`);
        }
    }

    async leaveChannel() {
        if (this._dc) { try { this._dc.destroy?.(); } catch (_) {} }
        if (this._peerConn) { try { this._peerConn.destroy?.(); } catch (_) {} }
        if (this._torrent) { try { this._torrent.destroy(); } catch (_) {} }
        this._torrent = null;
        this._peerConn = null;
        this._dc = null;
        this._handshakeDone = false;
        this._incomingBuffer = new Uint8Array(0);
        this._incomingOffset = 0;
        this._clearHandshakeTimer();
        this.currentChannel = '';
        this.currentPeerCount = 0;
        this.peerPublicKey = '';
        this.peerAddress = '';
        this.messageIds.clear();
        this.emit({ type: 'peer-count', count: 0 });
        this.emit({ type: 'left' });
    }

    sendChatMessage(text, identity) {
        if (!this._dc || !this._handshakeDone) throw new Error('Connection is not ready yet.');
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
        if (!this._dc || !this._handshakeDone) return;
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

    async transmit(payload) {
        try {
            if (!this._dc || !this._handshakeDone) return;
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

            this._dc.write(textEncoder.encode(this.encodeFrame(wire)));
        } catch (err) {
            this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        }
    }

    _startHandshakeTimer() {
        this._clearHandshakeTimer();
        this._handshakeTimer = setTimeout(() => {
            if (this._handshakeDone || !this._peerConn) return;
            const warning = new Error(`Handshake timeout after ${Math.floor(HANDSHAKE_TIMEOUT_MS / 1000)}s: hello not verified yet.`);
            this.emit({ type: 'warning', warning });
            this.emit({ type: 'debug', message: 'handshake timeout (connection kept open for diagnostics)' });
        }, HANDSHAKE_TIMEOUT_MS);
    }

    _clearHandshakeTimer() {
        if (this._handshakeTimer) {
            clearTimeout(this._handshakeTimer);
            this._handshakeTimer = null;
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
     * Send a File object over the connection in chunks.
     * @param {File} file
     * @param {{ address?: string } | null} identity
     */
    async sendFile(file, identity) {
        if (!this._dc || !this._handshakeDone) throw new Error('Connection is not ready yet.');

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
}
