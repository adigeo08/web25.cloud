// @ts-check

const CHAT_EXTENSION_NAME = 'web25_channels_v1';

/** Maximum number of noPeers retry attempts per joinChannel call. */
const CHANNEL_RETRY_MAX = 4;
/** Base delay (ms) for exponential-backoff retry of channel joins. */
const CHANNEL_RETRY_BASE_MS = 3000;

/**
 * Exponential backoff with jitter, capped at 30 s.
 * @param {number} attempt - zero-based attempt index
 * @param {number} baseMs
 */
function calcRetryDelay(attempt, baseMs) {
    return Math.min(30000, baseMs * Math.pow(2, attempt) + Math.random() * 1000);
}

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
        this.currentChannelLabel = '';
        this.currentChannelHash = '';
        this.messageIds = new Set();
        this.listeners = new Set();
        this.currentPeerCount = 0;
        /** @type {ReturnType<typeof setTimeout> | null} */
        this._retryTimeout = null;
    }

    onUpdate(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event) {
        this.listeners.forEach((listener) => listener(event));
    }

    async joinChannel(channelName, identity) {
        const descriptor = await this.resolveChannelDescriptor(channelName);
        if (!descriptor) throw new Error('Channel name or hash is required.');

        // Cancel any pending retry before replacing the channel.
        if (this._retryTimeout) {
            clearTimeout(this._retryTimeout);
            this._retryTimeout = null;
        }

        await this.leaveChannel();
        this.messageIds.clear();
        this.currentPeerCount = 0;
        this.currentChannel = descriptor.key;
        this.currentChannelLabel = descriptor.label;
        this.currentChannelHash = descriptor.infoHash;

        const magnetURI = `magnet:?xt=urn:btih:${descriptor.infoHash}&dn=${encodeURIComponent(`web25-channel-${descriptor.label}`)}`;

        const torrent = this._addChannelTorrent(magnetURI, descriptor, identity, 0);
        if (!torrent) throw new Error('Could not open channel swarm.');

        this.emit({ type: 'joined', channel: descriptor.label, channelHash: descriptor.infoHash, infoHash: descriptor.infoHash });
        this.pushLocalSystemMessage(`Connected to #${descriptor.label} (${descriptor.infoHash.slice(0, 10)}…).`, identity?.address);
    }

    /**
     * Internal: add a channel torrent and wire up listeners with retry support.
     * @param {string} magnetURI
     * @param {{ key: string, label: string, infoHash: string }} descriptor
     * @param {*} identity
     * @param {number} retryAttempt - how many noPeers retries have been performed
     */
    _addChannelTorrent(magnetURI, descriptor, identity, retryAttempt) {
        const torrent = this.client.add(magnetURI, { announce: this.trackers, destroyStoreOnDestroy: true });
        if (!torrent) return null;

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

            // Guard: don't retry if the user already left or re-joined a different channel.
            if (this.currentTorrent !== torrent || this.currentChannel !== descriptor.key) return;
            if (retryAttempt >= CHANNEL_RETRY_MAX) return;

            const nextAttempt = retryAttempt + 1;
            const delay = calcRetryDelay(retryAttempt, CHANNEL_RETRY_BASE_MS);

            if (this._retryTimeout) clearTimeout(this._retryTimeout);
            this._retryTimeout = setTimeout(() => {
                // Re-check guards after the delay fires.
                if (this.currentTorrent !== torrent || this.currentChannel !== descriptor.key) return;
                torrent.destroy({ destroyStore: true }, () => {
                    if (this.currentChannel !== descriptor.key) return;
                    this.currentTorrent = null;
                    this._addChannelTorrent(magnetURI, descriptor, identity, nextAttempt);
                });
            }, delay);
        });

        return torrent;
    }

    async leaveChannel() {
        if (this._retryTimeout) {
            clearTimeout(this._retryTimeout);
            this._retryTimeout = null;
        }
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
        this.currentChannelLabel = '';
        this.currentChannelHash = '';
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

    isHashChannel(value) {
        return /^[a-f0-9]{40}$/i.test(`${value || ''}`.trim());
    }

    async resolveChannelDescriptor(value) {
        const raw = `${value || ''}`.trim();
        if (!raw) return null;

        if (this.isHashChannel(raw)) {
            const hash = raw.toLowerCase();
            return {
                key: hash,
                label: `hash-${hash.slice(0, 12)}`,
                infoHash: hash
            };
        }

        const normalized = this.normalizeChannel(raw);
        if (!normalized) return null;
        const infoHash = await this.sha1Hex(`web25:${normalized}`);
        return {
            key: infoHash,
            label: normalized,
            infoHash
        };
    }

    async sha1Hex(input) {
        const bytes = new TextEncoder().encode(input);
        const digest = await crypto.subtle.digest('SHA-1', bytes);
        return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
}
