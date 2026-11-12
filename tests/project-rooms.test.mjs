import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { nostrCore } from '../src/nostr/nostr.js';
import { projectRoomId, newProjectId, signProject, verifyProject, projectHash } from '../src/channels/ProjectRoom.js';
import { conversationRoomId } from '../src/channels/ConversationRoom.js';
import { ProjectService, parseProjectMessage } from '../src/channels/ProjectService.js';
import { createTorrentChainArtifact, verifyTorrentChainManifest } from '../src/torrent/TorrentChainProtocol.js';
import { evmAddressFromPublicKey } from '../src/channels/ecies.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const encoder = new TextEncoder();
const hex = (bytes) => Buffer.from(bytes).toString('hex');
function digest(message) {
    const bytes = encoder.encode(message);
    return keccak_256(new Uint8Array([...encoder.encode(`\x19Ethereum Signed Message:\n${bytes.length}`), ...bytes]));
}
function identity(n) {
    const key = n.toString(16).padStart(64, '0');
    const pub = hex(secp256k1.getPublicKey(key, false));
    const owner = pub.slice(2, 66);
    return {
        owner,
        publisher: evmAddressFromPublicKey(pub),
        getNostrIdentity: async () => ({ nostrPublicKey: owner }),
        nostrSignEvent: async (template) => nostrCore.signEvent(template, key),
        signPayload: async (payload) => {
            const message = JSON.stringify(payload),
                sig = secp256k1.sign(digest(message), key);
            return {
                payload,
                message,
                signature: `0x${hex(sig.toCompactRawBytes())}${(sig.recovery + 27).toString(16)}`
            };
        }
    };
}
const verifySignature = async (message, signature, publisher) => {
    try {
        const sig = secp256k1.Signature.fromCompact(signature.slice(2, 130)).addRecoveryBit(
            parseInt(signature.slice(130), 16) - 27
        );
        return (
            evmAddressFromPublicKey(hex(sig.recoverPublicKey(digest(message)).toRawBytes(false))).toLowerCase() ===
            publisher.toLowerCase()
        );
    } catch (_) {
        return false;
    }
};
const verifyManifest = (m) => verifyTorrentChainManifest(m, verifySignature);
const memory = (owner) => {
    let state = { owned: {}, followed: {} },
        queue = Promise.resolve();
    return {
        change(fn) {
            const result = queue.then(async () => {
                const next = structuredClone(state);
                const value = await fn(next, owner);
                state = next;
                return value;
            });
            queue = result.catch(() => {});
            return result;
        }
    };
};
const artifact = (signer, project) =>
    createTorrentChainArtifact({
        inMemoryFiles: [{ name: 'index.html', arrayBuffer: async () => encoder.encode('hello').buffer }],
        publisher: signer.publisher,
        chainId: 1,
        identityType: 'local',
        createdAt: '2026-11-12T00:00:00Z',
        project,
        signPayload: signer.signPayload
    });

test('project rooms are deterministic, independent and distinct from unchanged direct rooms', () => {
    const a = identity(1),
        b = identity(2),
        id = newProjectId();
    assert.equal(projectRoomId(id, a.owner), projectRoomId(id, a.owner));
    assert.notEqual(projectRoomId(id, a.owner), projectRoomId(newProjectId(), a.owner));
    assert.notEqual(projectRoomId(id, a.owner), projectRoomId(id, b.owner));
    assert.ok(projectRoomId(id, a.owner).length <= 40);
    assert.equal(conversationRoomId(a.owner, b.owner), conversationRoomId(b.owner, a.owner));
    assert.match(conversationRoomId(a.owner, b.owner), /^room-/);
});

test('both ownership signatures cover project metadata; legacy manifests remain valid; no self infohash', async () => {
    const a = identity(1),
        b = identity(2),
        id = newProjectId();
    const p = await signProject(
        { id, roomId: projectRoomId(id, a.owner), ownerNostrPubkey: a.owner, version: 1, previousManifestHash: null },
        a.publisher,
        a
    );
    const { manifest } = await artifact(a, p);
    assert.equal((await verifyManifest(manifest)).verified, true);
    assert.equal(verifyProject(p, b.publisher), false);
    for (const mutate of [
        (m) => m.payload.project.version++,
        (m) => (m.payload.project.roomId = 'prj-' + '0'.repeat(32)),
        (m) => (m.payload.project.ownerNostrPubkey = b.owner),
        (m) => (m.signature = '0x' + '0'.repeat(130)),
        (m) => (m.payload.project.ownershipProof.sig = '0'.repeat(128))
    ]) {
        const changed = structuredClone(manifest);
        mutate(changed);
        assert.equal((await verifyManifest(changed)).verified, false);
        // Re-signing with the wallet alone cannot forge another Nostr proof.
        const signed = await a.signPayload(changed.payload);
        Object.assign(changed, signed);
        if (
            changed.payload.project.version !== 1 ||
            changed.payload.project.roomId !== p.roomId ||
            changed.payload.project.ownerNostrPubkey !== a.owner ||
            changed.payload.project.ownershipProof.sig !== p.ownershipProof.sig
        )
            assert.equal((await verifyManifest(changed)).verified, false);
    }
    assert.equal((await verifyManifest((await artifact(a, null)).manifest)).verified, true);
    assert.equal(JSON.stringify(manifest).includes('infoHash'), false);
});

test('Alice/Bob private subscriptions, independent project routing, offline replay, updates, failures and unsubscribe', async () => {
    const a = identity(1),
        b = identity(2),
        c = identity(3);
    const messages = [];
    const stores = [memory(a.owner), memory(b.owner), memory(c.owner)];
    let fail = false;
    const service = (signer, store) =>
        new ProjectService({
            signer,
            store,
            verifyManifest,
            send: async (peer, kind, content) => {
                if (fail) throw Error('offline');
                messages.push({ sender: signer.owner, peer, kind, content });
            }
        });
    const alice = service(a, stores[0]),
        bob = service(b, stores[1]),
        carol = service(c, stores[2]);
    const p1 = await alice.prepare(null, a.publisher, 'Alice');
    const m1 = (await artifact(a, p1)).manifest;
    assert.equal((await alice.prepare(p1.id, a.publisher)).version, 1, 'staging does not advance versions');
    await alice.published(m1, '1'.repeat(40));
    await bob.follow(m1, true);
    await carol.follow(m1, true);
    const subscriptions = messages.splice(0);
    for (const m of subscriptions)
        assert.equal(await alice.receive(m.content, m.sender), true, 'unknown contacts may subscribe');
    for (const m of messages.splice(0)) await (m.peer === b.owner ? bob : carol).receive(m.content, m.sender);
    assert.equal((await bob.inspect()).followed[p1.id].status, 'subscribed');
    const other = await alice.prepare(null, a.publisher, 'Independent');
    assert.notEqual(other.roomId, p1.roomId);
    const p2 = await alice.prepare(p1.id, a.publisher);
    assert.equal(p2.roomId, p1.roomId);
    assert.equal(p2.version, 2);
    assert.equal(p2.previousManifestHash, projectHash(JSON.stringify(m1)));
    const m2 = (await artifact(a, p2)).manifest;
    fail = true;
    assert.deepEqual(await alice.published(m2, '2'.repeat(40)), ['failed', 'failed']);
    assert.equal(
        (await alice.inspect()).owned[p1.id].history.length,
        2,
        'notification failure preserves successful deployment'
    );
    fail = false;
    await alice.retry(p1.id);
    const updates = messages.splice(0);
    assert.equal(updates.length, 2, 'private fan-out per recipient');
    const forBob = updates.find((m) => m.peer === b.owner);
    assert.equal(await bob.receive(forBob.content, c.owner), false, 'impersonated owner rejected');
    const resumedBob = service(b, stores[1]); // same durable state, new session, retained inbox
    assert.equal(await resumedBob.receive(forBob.content, a.owner), true);
    assert.equal(await resumedBob.receive(forBob.content, a.owner), false, 'replays rejected');
    const unrelated = JSON.parse(forBob.content);
    unrelated.projectId = other.id;
    unrelated.roomId = other.roomId;
    assert.equal(await resumedBob.receive(JSON.stringify(unrelated), a.owner), false);
    await assert.rejects(() => alice.prepare(p1.id, c.publisher), /migration/);
    const {ownershipProof: _oldProof, ...metadata} = p2;
    const migratedProof = await signProject(metadata, c.publisher, a);
    const migratedManifest = (await artifact(c, migratedProof)).manifest;
    assert.equal((await verifyManifest(migratedManifest)).verified, true, 'both new ownership signatures are independently valid');
    await assert.rejects(() => resumedBob.verifyViewed(migratedManifest), /identity changed/);
    await resumedBob.verifyViewed(m2);
    assert.equal((await resumedBob.inspect()).followed[p1.id].updates[0].contentVerified, true);
    const forged = structuredClone(m2);
    forged.payload.publisher = c.publisher;
    Object.assign(forged, await c.signPayload(forged.payload));
    await assert.rejects(() => resumedBob.verifyViewed(forged));
    await resumedBob.follow(m1, false);
    const unsubscribe = messages.splice(0)[0];
    await alice.receive(unsubscribe.content, b.owner);
    messages.splice(0);
    const p3 = await alice.prepare(p1.id, a.publisher);
    await alice.published((await artifact(a, p3)).manifest, '3'.repeat(40));
    assert.equal(messages.filter((m) => m.peer === b.owner).length, 0);
    assert.equal(messages.filter((m) => m.peer === c.owner).length, 1);
    assert.equal((await resumedBob.inspect()).followed[p1.id].updates.length, 1);
});

test('strict protocol rejects oversized, malformed and unsafe payloads', () => {
    assert.throws(() => parseProjectMessage('x'.repeat(8193)));
    assert.throws(() => parseProjectMessage('{}'));
    const p = { id: newProjectId(), roomId: 'prj-' + '1'.repeat(32) };
    const service = new ProjectService({ signer: identity(1), store: memory(identity(1).owner), send: async () => {} });
    const m = service.message('update', p, {
        version: 2,
        infoHash: 'a'.repeat(40),
        manifestHash: 'b'.repeat(64),
        previousManifestHash: 'c'.repeat(64),
        publishedAt: new Date().toISOString()
    });
    assert.equal(parseProjectMessage(JSON.stringify(m)).version, 2);
    for (const extra of [
        { mirrorURL: 'javascript:alert(1)' },
        { magnetURI: 'magnet:?xt=urn:btih:' + 'd'.repeat(40) },
        { version: 0 },
        { schema: 2 },
        { surprise: true }
    ])
        assert.throws(() => parseProjectMessage(JSON.stringify({ ...m, ...extra })));
});

test('encrypted IndexedDB project registry survives a new store, chunks large history and isolates identities', async () => {
    const { ProjectStore } = await import('../src/channels/ProjectStore.js');
    const { installFakeIndexedDb } = await import('./helpers/fake-indexeddb.mjs');
    const fake = installFakeIndexedDb();
    const a = identity(1),
        b = identity(2);
    const signer = (n, person) => ({
        ...person,
        nostrEncrypt: async (text, peer) =>
            nostrCore.nip44Encrypt(text, nostrCore.nip44ConversationKey(n.toString(16).padStart(64, '0'), peer)),
        nostrDecrypt: async (text, peer) =>
            nostrCore.nip44Decrypt(text, nostrCore.nip44ConversationKey(n.toString(16).padStart(64, '0'), peer))
    });
    try {
        const store = new ProjectStore(signer(1, a));
        const payload = '🌍'.repeat(40000);
        await store.change((s) => {
            s.owned.secret = { payload };
        });
        assert.equal(await new ProjectStore(signer(1, a)).change((s) => s.owned.secret.payload), payload);
        assert.deepEqual(await new ProjectStore(signer(2, b)).change((s) => s.owned), {});
        const locked = new ProjectStore({
            ...signer(1, a),
            getNostrIdentity: async () => {
                throw Error('locked');
            }
        });
        await assert.rejects(() => locked.change(() => {}), /locked/);
    } finally {
        fake.restore();
    }
});

test('real NIP-59 project messages route independently of ordinary chat and replay after inbox restart', async () => {
    const { NostrDirectMessageSession } = await import('../src/channels/NostrDirectMessageSession.js');
    const { PROJECT_KIND } = await import('../src/channels/ProjectRoom.js');
    const { InboxLedger } = await import('../src/channels/InboxLedger.js');
    const a = identity(1),
        b = identity(2);
    const signer = (n, p) => ({
        ...p,
        nostrEncrypt: async (text, peer) =>
            nostrCore.nip44Encrypt(text, nostrCore.nip44ConversationKey(n.toString(16).padStart(64, '0'), peer)),
        nostrDecrypt: async (text, peer) =>
            nostrCore.nip44Decrypt(text, nostrCore.nip44ConversationKey(n.toString(16).padStart(64, '0'), peer))
    });
    const retained = [];
    const pool = {
        connect: async () => {},
        publish: async (event) => {
            retained.push(event);
            return { accepted: ['wss://mock'] };
        },
        subscribe: () => ({ close() {} })
    };
    const alice = new NostrDirectMessageSession({
        pool,
        signer: signer(1, a),
        ledger: new InboxLedger({ persistent: false })
    });
    await alice.start();
    const p = { id: newProjectId(), roomId: 'prj-' + '1'.repeat(32) };
    const message = new ProjectService({ signer: a, send: async () => {}, store: memory(a.owner) }).message(
        'subscribe',
        p
    );
    await alice.sendGiftWrapped(b.owner, PROJECT_KIND, JSON.stringify(message));
    assert.equal(retained[0].kind, 1059);
    assert.equal(retained[0].content.includes(p.id), false);
    let project = 0,
        chat = 0;
    const bob = new NostrDirectMessageSession({
        pool,
        signer: signer(2, b),
        ledger: new InboxLedger({ persistent: false }),
        onChatEnvelope: () => {
            chat++;
        }
    });
    bob.onProjectMessage = async (content, sender) => {
        assert.equal(sender, a.owner);
        assert.equal(JSON.parse(content).projectId, p.id);
        project++;
    };
    await bob.start();
    await bob._handleGiftWrap(retained[0]);
    assert.equal(project, 1);
    assert.equal(chat, 0);
    bob.stop();
    await bob.start();
    await bob._handleGiftWrap(retained[0]);
    assert.equal(project, 2, 'project route uses durable project state deduplication, not precommit inbox claims');
});

test('actual deploy lifecycle remains successful when project notification finalization fails', async () => {
    globalThis.window = { location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' } };
    globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    const { deploySignedArtifact } = await import('../src/core/bootstrap/Lifecycle.js');
    let deployed = false,
        completed = false,
        warning = '';
    const hash = 'a'.repeat(40);
    const context = {
        lastPublishCandidate: {
            hash,
            projectManifest: { payload: { project: { roomId: 'prj-' + 'b'.repeat(32), version: 2 } } }
        },
        lastSignature: {},
        lastSignedPublish: { torrentHash: hash },
        authController: { getActiveIdentity: () => ({ address: identity(1).publisher }) },
        isGoFileMirrorRequested: () => false,
        renderDeployedArtifact: () => {
            deployed = true;
        },
        completeDeployment: async () => {
            completed = true;
        },
        projectService: {
            published: async () => {
                throw Error('relay unavailable');
            }
        },
        log: () => {},
        toast: {
            warning: (message) => {
                warning = message;
            }
        },
        refreshDeployUiState: () => {}
    };
    await deploySignedArtifact.call(context);
    assert.equal(deployed, true);
    assert.equal(completed, true);
    assert.match(warning, /relay unavailable/);
    assert.equal(context._deployInFlight, null);
});

test('newest-first offline relay replay queues gaps and releases only hash-linked versions', async () => {
    const a = identity(1),
        b = identity(2),
        id = newProjectId(),
        roomId = projectRoomId(id, a.owner);
    const store = memory(b.owner);
    await store.change((s) => {
        s.followed[id] = {
            id,
            roomId,
            ownerNostrPubkey: a.owner,
            active: true,
            version: 1,
            manifestHash: '1'.repeat(64),
            updates: []
        };
    });
    let bob = new ProjectService({ signer: b, store, send: async () => {} });
    const update = (version, prev, hash) =>
        JSON.stringify(
            bob.message(
                'update',
                { id, roomId },
                {
                    version,
                    previousManifestHash: prev.repeat(64),
                    manifestHash: hash.repeat(64),
                    infoHash: hash.repeat(40),
                    publishedAt: new Date().toISOString()
                }
            )
        );
    assert.equal(await bob.receive(update(3, '2', '3'), a.owner), false);
    assert.equal((await bob.inspect()).followed[id].version, 1);
    bob = new ProjectService({ signer: b, store, send: async () => {} });
    assert.equal(await bob.receive(update(2, '1', '2'), a.owner), true);
    const state = (await bob.inspect()).followed[id];
    assert.equal(state.version, 3);
    assert.deepEqual(
        state.updates.map((u) => u.version),
        [2, 3]
    );
    assert.equal(await bob.receive(update(2, '1', '2'), a.owner), false);
    assert.equal(await bob.receive(update(4, 'f', '4'), a.owner), false, 'unlinked next version rejected');
    assert.equal(await bob.receive(update(100, '3', '4'), a.owner), false, 'gap storage is bounded');
});
