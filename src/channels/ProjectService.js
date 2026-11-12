// @ts-check
import { ProjectStore } from './ProjectStore.js';
import { newProjectId, projectRoomId, projectHash, signProject, PROJECT_KIND } from './ProjectRoom.js';
import { verifyTorrentChainManifest } from '../torrent/TorrentChainProtocol.js';
const TYPES = ['web25-project-subscribe', 'web25-project-unsubscribe', 'web25-project-ack', 'web25-project-update'];
export function parseProjectMessage(content) {
    if (typeof content !== 'string' || new TextEncoder().encode(content).length > 8192) {
        throw new Error('Project message too large');
    }
    const m = JSON.parse(content);
    if (
        !TYPES.includes(m.type) ||
        m.schema !== 1 ||
        !/^[0-9a-f]{64}$/.test(m.projectId) ||
        !/^prj-[0-9a-f]{32}$/.test(m.roomId) ||
        !/^[0-9a-f]{64}$/.test(m.requestId) ||
        !Number.isSafeInteger(m.at) ||
        m.at < 0 ||
        m.at > Date.now() + 300000
    ) {
        throw new Error('Invalid project message');
    }
    const common = ['type', 'schema', 'projectId', 'roomId', 'requestId', 'at'];
    const extra =
        m.type === 'web25-project-update'
            ? ['version', 'infoHash', 'magnetURI', 'mirrorURL', 'previousManifestHash', 'manifestHash', 'publishedAt']
            : m.type === 'web25-project-ack'
              ? ['active', 'replyTo']
              : [];
    if (Object.keys(m).some((k) => ![...common, ...extra].includes(k))) {
        throw new Error('Unknown project message field');
    }
    if (m.type === 'web25-project-ack' && (typeof m.active !== 'boolean' || !/^[0-9a-f]{64}$/.test(m.replyTo))) {
        throw new Error('Invalid acknowledgement');
    }
    if (m.type === 'web25-project-update') {
        if (
            !Number.isSafeInteger(m.version) ||
            m.version < 1 ||
            !/^[0-9a-f]{40}$/.test(m.infoHash) ||
            !/^[0-9a-f]{64}$/.test(m.manifestHash) ||
            !(m.previousManifestHash === null || /^[0-9a-f]{64}$/.test(m.previousManifestHash)) ||
            typeof m.publishedAt !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T/.test(m.publishedAt) ||
            !Number.isFinite(Date.parse(m.publishedAt))
        ) {
            throw new Error('Invalid update');
        }
        if (m.magnetURI !== undefined && typeof m.magnetURI !== 'string') throw new Error('Invalid magnet');
        if (m.mirrorURL !== undefined && typeof m.mirrorURL !== 'string') throw new Error('Invalid mirror');
        if (
            m.magnetURI &&
            (m.magnetURI.length > 2048 || !m.magnetURI.startsWith(`magnet:?xt=urn:btih:${m.infoHash}`))
        ) {
            throw new Error('Invalid magnet');
        }
        if (m.mirrorURL && (m.mirrorURL.length > 2048 || new URL(m.mirrorURL).protocol !== 'https:')) {
            throw new Error('Invalid mirror');
        }
    }
    return m;
}
export class ProjectService {
    constructor({
        signer,
        send,
        store = new ProjectStore(signer),
        onChange = () => {},
        verifyManifest = verifyTorrentChainManifest
    }) {
        Object.assign(this, { signer, send, store, onChange, verifyManifest });
    }
    message(type, p, extra = {}) {
        return {
            type: `web25-project-${type}`,
            schema: 1,
            projectId: p.id,
            roomId: p.roomId,
            requestId: newProjectId(),
            at: Date.now(),
            ...extra
        };
    }
    async transmit(peer, message) {
        parseProjectMessage(JSON.stringify(message));
        return this.send(peer, PROJECT_KIND, JSON.stringify(message));
    }
    async prepare(id, publisher, name = 'Project') {
        return this.store.change(async (s, owner) => {
            let p = id && s.owned[id];
            if (id && !p) throw new Error('Select an existing project or explicitly create a new one');
            if (!p) {
                id = newProjectId();
                p = s.owned[id] = {
                    id,
                    roomId: projectRoomId(id, owner),
                    ownerNostrPubkey: owner,
                    publisher: publisher.toLowerCase(),
                    name: name.slice(0, 128),
                    history: [],
                    subscribers: {},
                    deliveries: {}
                };
            }
            if (p.publisher !== publisher.toLowerCase() || p.ownerNostrPubkey !== owner) {
                throw new Error('Project owner migration is not supported');
            }
            const last = p.history.at(-1);
            return signProject(
                {
                    id,
                    roomId: p.roomId,
                    ownerNostrPubkey: owner,
                    version: (last?.version || 0) + 1,
                    previousManifestHash: last?.manifestHash || null
                },
                publisher,
                this.signer
            );
        });
    }
    async follow(manifest, active) {
        if (!(await this.verifyManifest(manifest)).verified || !manifest.payload.project) {
            throw new Error('Project is not verified');
        }
        const p = manifest.payload.project;
        const message = this.message(active ? 'subscribe' : 'unsubscribe', p);
        await this.store.change((s) => {
            const old = s.followed[p.id];
            if (
                old &&
                (old.publisher !== manifest.payload.publisher.toLowerCase() ||
                    old.ownerNostrPubkey !== p.ownerNostrPubkey)
            ) {
                throw new Error('Project owner changed');
            }
            message.at = Math.max(message.at, (old?.requestAt || 0) + 1);
            s.followed[p.id] = {
                ...old,
                requestAt: message.at,
                ...p,
                publisher: manifest.payload.publisher.toLowerCase(),
                manifest,
                version: old?.version || p.version,
                manifestHash: old?.manifestHash || projectHash(JSON.stringify(manifest)),
                active,
                status: active ? 'pending' : 'unsubscribed',
                pending: message.requestId,
                pendingMessage: message,
                updates: old?.updates || []
            };
        });
        await this.transmit(p.ownerNostrPubkey, message);
        this.onChange();
    }
    async retryRequest(id) {
        const p = await this.store.change((s) => structuredClone(s.followed[id]));
        if (!p?.pendingMessage) throw new Error('No subscription request to retry');
        await this.transmit(p.ownerNostrPubkey, p.pendingMessage);
        this.onChange();
    }
    async receive(content, sender) {
        if (!/^[0-9a-f]{64}$/.test(sender)) throw new Error('Invalid Nostr sender');
        const m = parseProjectMessage(content);
        let reply;
        const accepted = await this.store.change((s, owner) => {
            if (m.type === 'web25-project-subscribe' || m.type === 'web25-project-unsubscribe') {
                const p = s.owned[m.projectId];
                if (!p || p.roomId !== m.roomId || p.ownerNostrPubkey !== owner || !p.history.length) return false;
                const previous = p.subscribers[sender];
                if (previous?.requestId === m.requestId) {
                    reply = this.message('ack', p, { active: previous.active, replyTo: m.requestId });
                    return false;
                }
                if (previous && m.at <= previous.at) return false;
                if (!previous && Object.keys(p.subscribers).length >= 1000) return false;
                const active = m.type === 'web25-project-subscribe';
                p.subscribers[sender] = { active, at: m.at, requestId: m.requestId };
                reply = this.message('ack', p, { active, replyTo: m.requestId });
                return true;
            }
            const p = s.followed[m.projectId];
            if (!p || p.ownerNostrPubkey !== sender || p.roomId !== m.roomId) return false;
            if (m.type === 'web25-project-ack') {
                if (p.pending !== m.replyTo) return false;
                if (m.active !== p.active) return false;
                p.status = m.active ? 'subscribed' : 'unsubscribed';
                p.pendingMessage = null;
                return true;
            }
            if (!p.active || m.version <= p.version || m.version > p.version + 64) return false;
            if (m.version === p.version + 1 && m.previousManifestHash !== p.manifestHash) return false;
            // Relays may replay newest first. Persist a bounded gap queue and
            // release only a hash-linked sequence, never a skipped version.
            p.queuedUpdates = p.queuedUpdates || {};
            if (p.queuedUpdates[m.version]?.manifestHash === m.manifestHash) return false;
            p.queuedUpdates[m.version] = m;
            let advanced = false;
            while (p.queuedUpdates[p.version + 1]) {
                const next = p.queuedUpdates[p.version + 1];
                delete p.queuedUpdates[p.version + 1];
                if (next.previousManifestHash !== p.manifestHash) break;
                p.version = next.version;
                p.manifestHash = next.manifestHash;
                p.updates.push({ ...next, contentVerified: false });
                advanced = true;
            }
            return advanced;
        });
        if (reply) await this.transmit(sender, reply);
        if (accepted) this.onChange();
        return accepted;
    }
    async published(manifest, infoHash, mirrorURL) {
        const p = manifest.payload.project;
        if (!p) return;
        if (!(await this.verifyManifest(manifest)).verified) throw new Error('Invalid published project');
        await this.store.change((s, owner) => {
            const record = s.owned[p.id];
            if (
                !record ||
                record.ownerNostrPubkey !== owner ||
                record.publisher !== manifest.payload.publisher.toLowerCase()
            ) {
                throw new Error('Project owner changed');
            }
            const last = record.history.at(-1);
            if (last?.infoHash === infoHash) return;
            if (p.version !== (last?.version || 0) + 1 || p.previousManifestHash !== (last?.manifestHash || null)) {
                throw new Error('Stale staged project version; sign again');
            }
            const update = this.message('update', p, {
                version: p.version,
                infoHash,
                manifestHash: projectHash(JSON.stringify(manifest)),
                previousManifestHash: p.previousManifestHash,
                publishedAt: new Date().toISOString(),
                magnetURI: `magnet:?xt=urn:btih:${infoHash}`,
                ...(mirrorURL ? { mirrorURL } : {})
            });
            record.history.push(update);
            for (const [peer, subscriber] of Object.entries(record.subscribers)) {
                if (subscriber.active) record.deliveries[`${p.version}:${peer}`] = { peer, update, state: 'pending' };
            }
        });
        try {
            return await this.retry(p.id);
        } catch (_) {
            return ['failed'];
        }
    }
    async retry(id) {
        const pending = await this.store.change((s) =>
            Object.entries(s.owned[id].deliveries).filter(
                ([, d]) => d.state !== 'relay-accepted' && s.owned[id].subscribers[d.peer]?.active
            )
        );
        for (const [key, delivery] of pending) {
            const claimed = await this.store.change((s) => {
                const d = s.owned[id].deliveries[key];
                if (
                    !s.owned[id].subscribers[d.peer]?.active ||
                    d.state === 'relay-accepted' ||
                    (d.leaseUntil || 0) > Date.now()
                ) {
                    return false;
                }
                d.leaseUntil = Date.now() + 60000;
                return true;
            });
            if (!claimed) continue;
            let state = 'failed';
            try {
                await this.transmit(delivery.peer, delivery.update);
                state = 'relay-accepted';
            } catch (_) {}
            await this.store.change((s) => {
                s.owned[id].deliveries[key].state = state;
                s.owned[id].deliveries[key].leaseUntil = 0;
            });
        }
        this.onChange();
        return this.store.change((s) => Object.values(s.owned[id].deliveries).map((d) => d.state));
    }
    async removeSubscriber(id, peer) {
        await this.store.change((s) => {
            s.owned[id].subscribers[peer].active = false;
        });
        this.onChange();
    }
    async verifyViewed(manifest) {
        if (!(await this.verifyManifest(manifest)).verified) throw new Error('Invalid project manifest');
        const p = manifest.payload.project;
        return this.store.change((s) => {
            if (!p) return;
            const followed = s.followed[p.id];
            if (!followed) return;
            if (
                followed.publisher !== manifest.payload.publisher.toLowerCase() ||
                followed.ownerNostrPubkey !== p.ownerNostrPubkey ||
                followed.roomId !== p.roomId
            ) {
                throw new Error('Project publisher identity changed');
            }
            const hash = projectHash(JSON.stringify(manifest));
            if (p.version === followed.version && hash !== followed.manifestHash) {
                throw new Error('Conflicting project version manifest');
            }
            const update = followed.updates.find((u) => u.version === p.version);
            if (update && update.manifestHash !== hash) throw new Error('Deployment does not match announced manifest');
            if (update) update.contentVerified = true;
        });
    }
    async inspect() {
        return this.store.change((s) => structuredClone(s));
    }
}
