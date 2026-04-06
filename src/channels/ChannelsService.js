// @ts-check

const DEFAULT_RTC_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function encodeSignal(description) {
    const raw = JSON.stringify(description);
    const descriptionB64 = toBase64(raw);
    const encryptionKey = generateHexKey(32);
    return JSON.stringify({
        description: descriptionB64,
        encryptionKey
    });
}

function decodeSignal(rawCode) {
    const clean = `${rawCode || ''}`.trim();
    if (!clean) throw new Error('Signal code is required.');

    try {
        const parsed = JSON.parse(clean);
        if (parsed?.description) {
            const decoded = fromBase64(parsed.description);
            return {
                description: JSON.parse(decoded),
                encryptionKey: `${parsed.encryptionKey || ''}`
            };
        }
    } catch (_) {}

    // backward-compatible decode for older base64-only signaling codes
    const fallback = fromBase64(clean);
    return {
        description: JSON.parse(fallback),
        encryptionKey: ''
    };
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

function generateHexKey(byteLength = 32) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return [...bytes].map((item) => item.toString(16).padStart(2, '0')).join('');
}

export default class ChannelsService {
    constructor({ rtcConfig = DEFAULT_RTC_CONFIG } = {}) {
        this.rtcConfig = rtcConfig;
        this.peerConnection = null;
        this.dataChannel = null;
        this.currentChannel = '';
        this.currentPeerCount = 0;
        this.messageIds = new Set();
        this.listeners = new Set();
        this.identityAddress = 'anonymous';
        this.role = '';
        this.sessionEncryptionKey = '';
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
        this.messageIds.clear();

        const peer = this.createPeerConnection();
        const channel = peer.createDataChannel('web25-direct-messenger');
        this.bindDataChannel(channel);
        this.dataChannel = channel;

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await this.waitForIceGathering(peer);

        const code = encodeSignal(peer.localDescription);
        this.sessionEncryptionKey = decodeSignal(code).encryptionKey;
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

        await this.leaveChannel();
        this.currentChannel = normalized;
        this.role = 'guest';
        this.identityAddress = identity?.address || 'anonymous';
        this.sessionEncryptionKey = offerSignal.encryptionKey || '';
        this.messageIds.clear();

        const peer = this.createPeerConnection();
        await peer.setRemoteDescription(offer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await this.waitForIceGathering(peer);

        const code = encodeSignal(peer.localDescription);
        if (!this.sessionEncryptionKey) {
            this.sessionEncryptionKey = decodeSignal(code).encryptionKey;
        }
        this.emit({ type: 'local-answer', code, channel: normalized });
        this.emit({ type: 'connecting', channel: normalized });
        return code;
    }

    async applyAnswer(answerCode) {
        if (!this.peerConnection || this.role !== 'host') throw new Error('Create an offer first.');
        const answerSignal = decodeSignal(answerCode);
        const answer = answerSignal.description;
        if (answer?.type !== 'answer') throw new Error('Answer code is invalid.');
        if (answerSignal.encryptionKey) {
            this.sessionEncryptionKey = answerSignal.encryptionKey;
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
        this.sessionEncryptionKey = '';
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
        this.transmit(payload);
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

        channel.onmessage = (event) => {
            try {
                const payload = JSON.parse(`${event?.data || ''}`);
                this.handleInbound(payload, false);
            } catch (_) {}
        };
    }

    transmit(payload) {
        try {
            if (!this.dataChannel || this.dataChannel.readyState !== 'open') return;
            this.dataChannel.send(JSON.stringify(payload));
        } catch (_) {}
    }

    handleInbound(payload, isLocal = false) {
        if (!payload || payload.channel !== this.currentChannel) return;
        if (payload.id && this.messageIds.has(payload.id)) return;
        if (payload.id) this.messageIds.add(payload.id);

        if (payload.type === 'chat') this.emit({ type: 'message', message: payload, local: isLocal });
        if (payload.type === 'system') this.emit({ type: 'system', payload, local: isLocal });
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
