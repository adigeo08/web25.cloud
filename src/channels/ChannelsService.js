// @ts-check

const CHAT_EXTENSION_NAME = 'web25_channels_v1';

class ChannelsWireExtension {
    constructor(service, wire) {
        this.name = CHAT_EXTENSION_NAME;
        this.service = service;
        this.wire = wire;
    }

    onExtendedHandshake() {
        this.service.onPeerConnected(this.wire);
    }

    onMessage(buffer) {
        try {
            const payload = JSON.parse(new TextDecoder().decode(buffer));
            this.service.handleInbound(payload, this.wire);
        } catch (_) {}
    }

    send(payload) {
        try {
            const raw = new TextEncoder().encode(JSON.stringify(payload));
            this.wire.extended(CHAT_EXTENSION_NAME, raw);
        } catch (_) {}
    }
}

export default class ChannelsService {
    constructor({ client, trackers }) {
        this.client = client;
        this.trackers = trackers;
        this.currentTorrent = null;
        this.currentChannel = '';
        this.messageIds = new Set();
        this.listeners = new Set();
        this.currentPeerCount = 0;
    }

    onUpdate(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event) {
        this.listeners.forEach((listener) => listener(event));
    }

    async joinChannel(channelName, identity) {
        const normalized = this.normalizeChannel(channelName);
        if (!normalized) throw new Error('Channel name is required.');

        await this.leaveChannel();
        this.messageIds.clear();
        this.currentPeerCount = 0;
        this.currentChannel = normalized;

        const infoHash = await this.sha1Hex(`web25:${normalized}`);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(`web25-channel-${normalized}`)}`;

        const torrent = this.client.add(magnetURI, { announce: this.trackers, destroyStoreOnDestroy: true });
        if (!torrent) throw new Error('Could not open channel swarm.');

        this.currentTorrent = torrent;
        torrent.on('wire', (wire) => {
            const extension = new ChannelsWireExtension(this, wire);
            wire.use(extension);
            wire.web25ChannelsExtension = extension;
            this.currentPeerCount = torrent.numPeers || 0;
            this.emit({ type: 'peer-count', count: this.currentPeerCount });
        });
        torrent.on('noPeers', () => {
            this.currentPeerCount = torrent.numPeers || 0;
            this.emit({ type: 'peer-count', count: this.currentPeerCount });
        });

        this.emit({ type: 'joined', channel: normalized, infoHash });
        this.pushLocalSystemMessage(`Connected to #${normalized}.`, identity?.address);
    }

    async leaveChannel() {
        if (!this.currentTorrent) return;
        await new Promise((resolve) => {
            try {
                this.currentTorrent.destroy({ destroyStore: true }, () => resolve());
            } catch (_) {
                resolve();
            }
        });
        this.currentTorrent = null;
        this.currentChannel = '';
        this.currentPeerCount = 0;
        this.emit({ type: 'left' });
    }

    sendChatMessage(text, identity) {
        if (!this.currentTorrent || !this.currentChannel) throw new Error('Join a channel first.');
        const clean = `${text || ''}`.trim();
        if (!clean) return;

        const payload = {
            type: 'chat',
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            text: clean,
            channel: this.currentChannel,
            from: identity?.address || 'anonymous',
            timestamp: new Date().toISOString()
        };

        this.handleInbound(payload, true);
        this.broadcast(payload);
    }

    onPeerConnected(wire) {
        wire.web25ChannelsExtension?.send({
            type: 'presence',
            id: `hello-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            channel: this.currentChannel,
            from: 'peer',
            timestamp: new Date().toISOString()
        });
    }

    broadcast(payload) {
        if (!this.currentTorrent?.wires) return;
        this.currentTorrent.wires.forEach((wire) => wire.web25ChannelsExtension?.send(payload));
    }

    handleInbound(payload, isLocal = false) {
        if (!payload || payload.channel !== this.currentChannel) return;
        if (payload.id && this.messageIds.has(payload.id)) return;
        if (payload.id) this.messageIds.add(payload.id);
        if (payload.type === 'chat') this.emit({ type: 'message', message: payload, local: isLocal });
    }

    pushLocalSystemMessage(text, address = null) {
        this.handleInbound(
            {
                type: 'chat',
                id: `system-${Date.now()}`,
                text,
                channel: this.currentChannel,
                from: address || 'system',
                timestamp: new Date().toISOString()
            },
            true
        );
    }

    normalizeChannel(value) {
        return `${value || ''}`.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 40);
    }

    async sha1Hex(input) {
        const bytes = new TextEncoder().encode(input);
        const digest = await crypto.subtle.digest('SHA-1', bytes);
        return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
}
