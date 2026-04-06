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
            // FIX: pass false (isLocal=false) — not this.wire — so remote messages are
            // correctly marked as non-local in handleInbound.
            this.service.handleInbound(payload, false);
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
        const trackerParams = (this.trackers || [])
            .map((tracker) => `${tracker || ''}`.trim())
            .filter(Boolean)
            .map((tracker) => `tr=${encodeURIComponent(tracker)}`)
            .join('&');
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(`web25-channel-${normalized}`)}${
            trackerParams ? `&${trackerParams}` : ''
        }`;

        const torrent = this._addChannelTorrent(magnetURI);
        if (!torrent) throw new Error('Could not open channel swarm.');

        this.emit({ type: 'joined', channel: normalized, infoHash });
        this.pushLocalSystemMessage(`Connected to #${normalized}.`, identity?.address);
    }

    /**
     * Internal: add a channel torrent and wire up listeners.
     * @param {string} magnetURI
     */
    _addChannelTorrent(magnetURI) {
        const torrent = this._createTorrent(magnetURI);
        if (!torrent) return null;

        this.currentTorrent = torrent;
        this._bindTorrentEvents(torrent);
        return torrent;
    }

    /**
     * @param {string} magnetURI
     */
    _createTorrent(magnetURI) {
        return this.client.add(magnetURI, { destroyStoreOnDestroy: true });
    }

    /**
     * @param {*} torrent
     */
    _bindTorrentEvents(torrent) {
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

    sendSystemMessage(kind, data, identity = null) {
        if (!this.currentTorrent || !this.currentChannel) return;
        const payload = {
            type: 'system',
            id: `sig-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            channel: this.currentChannel,
            from: identity?.address || 'system',
            timestamp: new Date().toISOString(),
            data: {
                kind,
                ...data
            }
        };
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
        if (payload.type === 'system') this.emit({ type: 'system', payload, local: isLocal });
        if (payload.type === 'presence') {
            // Emit a presence event so the UI can react to peer announcements.
            this.emit({ type: 'presence', from: payload.from, timestamp: payload.timestamp });
            // Also refresh the peer count whenever a presence is received.
            this.currentPeerCount = this.currentTorrent?.numPeers || 0;
            this.emit({ type: 'peer-count', count: this.currentPeerCount });
        }
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
