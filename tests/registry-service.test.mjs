/**
 * The registry service: signing through the wallet worker, publishing to the
 * registry relays, retrying the same event, and discovery.
 *
 * The registry and the Direct Messenger share the relay client and the wallet
 * signing operation and nothing else, so these tests also pin that a registry
 * failure can never affect a deployment, and that a retry resubmits the very
 * same signed event rather than minting a second torrent entry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Web25RegistryService } from '../src/registry/Web25RegistryService.js';
import { WEB25_VERIFICATION, buildRegistryEventTemplate, firstTagValue } from '../src/registry/Web25RegistryEvent.js';
import { NOSTR_REGISTRY_CONFIG, DEFAULT_NOSTR_REGISTRY_RELAYS } from '../src/config/nostr.config.js';
import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';

const WALLET_PRIV = '0x1111111111111111111111111111111111111111111111111111111111111111';
const INFOHASH = 'e5a1c0d4b7f28369ac015be47d3902fa6c8b1d47';
const PUBLISHER = '0x1111111111111111111111111111111111111111';
const EVM_SIGNATURE = `0x${'9'.repeat(130)}`;
const TRACKER = 'wss://tracker.openwebtorrent.com/';

function torrent() {
    return {
        infoHash: INFOHASH,
        name: 'my-site',
        files: [
            { path: 'my-site/.torrentchain', name: '.torrentchain', length: 1234 },
            { path: 'my-site/site.bundle.json.gz', name: 'site.bundle.json.gz', length: 56789 }
        ],
        announce: [TRACKER]
    };
}

function chainArtifact() {
    const payload = {
        schema: 'web25-torrentchain-v1',
        publisher: PUBLISHER,
        chainId: 1,
        createdAt: '2026-02-01T10:00:00.000Z',
        fileCount: 2,
        totalBytes: 1200,
        merkleRoot: 'a'.repeat(64),
        filesSemantics: 'bundle-contents',
        bundle: { name: 'site.bundle.json.gz', sha256: 'b'.repeat(64), contentEncoding: 'gzip', schema: 'web25-sitebundle-v1' }
    };
    return { payload, message: JSON.stringify(payload), signature: EVM_SIGNATURE };
}

/**
 * The real wallet worker plus the narrow capability handle the app is given —
 * the same shape `createLocalWalletSigner()` produces.
 */
function makeWallet(privateKey = WALLET_PRIV) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let counter = 0;
    const call = async (type, payload = {}) => {
        counter += 1;
        const response = await core.handle({ id: `w${counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };

    const calls = { nostrSignEvent: 0, evmSignMessage: 0 };
    return {
        calls,
        unlock: () => core.handle({ id: 'unlock', type: WALLET_WORKER_OPS.UNLOCK, payload: { privateKey } }),
        lock: () => core.handle({ id: 'lock', type: WALLET_WORKER_OPS.LOCK }),
        signer: {
            getNostrIdentity: async () => call(WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY),
            nostrSignEvent: async (template) => {
                calls.nostrSignEvent += 1;
                return (await call(WALLET_WORKER_OPS.NOSTR_SIGN_EVENT, template)).event;
            },
            // Present so a stray EVM signing attempt would be observable.
            signMessage: async (message) => {
                calls.evmSignMessage += 1;
                return (await call(WALLET_WORKER_OPS.SIGN_MESSAGE, { message })).signature;
            }
        },
        nostrPublicKey: nostrCore.getNostrPublicKey(privateKey)
    };
}

/** A relay pool double with scriptable per-relay outcomes. */
class FakePool {
    constructor({ relays = ['wss://relay.dtan.xyz', 'wss://nos.lol'], failing = [], unreachable = false } = {}) {
        this.relayUrls = relays;
        this.failing = failing;
        this.unreachable = unreachable;
        this.published = [];
        this.subscriptions = [];
        this.connectCalls = 0;
        this.closed = false;
        this.status = relays.map((url) => ({ url, status: 'connected', lastError: null }));
    }

    async connect() {
        this.connectCalls += 1;
        if (this.unreachable) throw new Error('every registry relay is unreachable');
        return { connected: this.relayUrls.length, total: this.relayUrls.length };
    }

    async publish(event) {
        this.published.push(event);
        const accepted = this.relayUrls.filter((url) => !this.failing.includes(url));
        const rejected = Object.fromEntries(this.failing.map((url) => [url, 'blocked: relay down']));
        return { accepted, rejected, attempted: this.relayUrls.length };
    }

    subscribe(filters, onEvent) {
        const subscription = { filters, onEvent, closed: false };
        this.subscriptions.push(subscription);
        return {
            id: `fake-${this.subscriptions.length}`,
            close: () => {
                subscription.closed = true;
            }
        };
    }

    /** Push an event at every open subscription, as a relay would. */
    deliver(event, relayUrl = 'wss://relay.dtan.xyz') {
        for (const subscription of this.subscriptions) {
            if (!subscription.closed) subscription.onEvent(event, relayUrl);
        }
    }

    close() {
        this.closed = true;
    }
}

async function serviceWith(pool, { wallet = null } = {}) {
    const activeWallet = wallet || makeWallet();
    await activeWallet.unlock();
    const service = new Web25RegistryService({
        signer: activeWallet.signer,
        pool,
        verifyEvmSignature: async () => true
    });
    return { service, wallet: activeWallet };
}

function signedRegistryEvent(privateKey = WALLET_PRIV.slice(2)) {
    return nostrCore.signEvent(
        buildRegistryEventTemplate({ torrent: torrent(), chainArtifact: chainArtifact(), siteName: 'My Site' }),
        privateKey
    );
}

// ─── 1. Configuration ────────────────────────────────────────────────────

test('the registry relay list leads with DTAN and keeps generic relays for redundancy', () => {
    assert.equal(DEFAULT_NOSTR_REGISTRY_RELAYS[0], 'wss://relay.dtan.xyz');
    assert.ok(DEFAULT_NOSTR_REGISTRY_RELAYS.length > 1, 'no single relay may be required');
});

// ─── 2. Signing through the existing wallet worker ───────────────────────

test('the registry event is signed by the wallet-derived Nostr identity', async () => {
    const { service, wallet } = await serviceWith(new FakePool());
    const event = await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });

    assert.equal(event.pubkey, wallet.nostrPublicKey, 'the same key that backs the EVM identity');
    assert.equal(nostrCore.verifyEvent(event), true);
    assert.equal(event.kind, 2003);
    assert.equal(wallet.calls.nostrSignEvent, 1);
});

test('publishing to the registry generates no second EVM signature', async () => {
    const { service, wallet } = await serviceWith(new FakePool());
    const event = await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });
    await service.publishSignedEvent(event);

    assert.equal(wallet.calls.evmSignMessage, 0, 'the site was already signed when .torrentchain was created');
    assert.equal(firstTagValue(event.tags, 'web25-signature'), EVM_SIGNATURE, 'the existing signature is mirrored');
});

test('a locked wallet cannot create a registry event', async () => {
    const wallet = makeWallet();
    const service = new Web25RegistryService({ signer: wallet.signer, pool: new FakePool() });

    await assert.rejects(
        () => service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() }),
        /unlock your wallet|locked/i
    );
});

test('locking mid-session stops further registry signing', async () => {
    const { service, wallet } = await serviceWith(new FakePool());
    await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });

    await wallet.lock();
    await assert.rejects(
        () => service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() }),
        /locked|unlock/i
    );
});

test('no private key or nsec appears in a published registry event', async () => {
    const { service } = await serviceWith(new FakePool());
    const event = await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });
    const wire = JSON.stringify(event);

    assert.ok(!wire.includes(WALLET_PRIV), 'the private key must never be published');
    assert.ok(!wire.includes(WALLET_PRIV.slice(2)));
    assert.ok(!/nsec1/.test(wire));
});

// ─── 3. Relay behaviour ──────────────────────────────────────────────────

test('a partial relay failure still counts as published', async () => {
    const pool = new FakePool({ failing: ['wss://relay.dtan.xyz'] });
    const { service } = await serviceWith(pool);

    const event = await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });
    const result = await service.publishSignedEvent(event);

    assert.equal(result.ok, true);
    assert.deepEqual(result.accepted, ['wss://nos.lol']);
    assert.deepEqual(Object.keys(result.rejected), ['wss://relay.dtan.xyz']);
});

test('DTAN being unavailable is reported, never thrown', async () => {
    const pool = new FakePool({ relays: ['wss://relay.dtan.xyz'], failing: ['wss://relay.dtan.xyz'] });
    const { service } = await serviceWith(pool);

    const event = await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });
    const result = await service.publishSignedEvent(event);

    // A deployment is valid without a registry entry, so this resolves with a
    // failure report rather than rejecting and unwinding the deploy.
    assert.equal(result.ok, false);
    assert.equal(result.accepted.length, 0);
    assert.match(result.error, /no registry relay accepted/i);
    assert.equal(result.eventId, event.id, 'the same event stays available for retry');
});

test('a completely unreachable relay pool reports failure without throwing', async () => {
    const pool = new FakePool({ unreachable: true });
    const wallet = makeWallet();
    await wallet.unlock();
    const service = new Web25RegistryService({ signer: wallet.signer, pool });

    const event = await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });
    const result = await service.publishSignedEvent(event);

    assert.equal(result.ok, false);
    assert.match(result.error, /unreachable/i);
});

// ─── 4. Retry idempotency ────────────────────────────────────────────────

test('a retry resubmits the exact same signed event', async () => {
    const pool = new FakePool({ relays: ['wss://relay.dtan.xyz'], failing: ['wss://relay.dtan.xyz'] });
    const { service } = await serviceWith(pool);

    const event = await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });
    const first = await service.publishSignedEvent(event);
    assert.equal(first.ok, false);

    // DTAN comes back.
    pool.failing = [];
    const retry = await service.publishSignedEvent(event);
    assert.equal(retry.ok, true);

    assert.equal(pool.published.length, 2);
    const [a, b] = pool.published;
    assert.equal(a.id, b.id, 'same event id');
    assert.equal(a.created_at, b.created_at, 'same created_at');
    assert.equal(a.sig, b.sig, 'same signature');
    assert.deepEqual(a.tags, b.tags, 'same tags');
});

test('a retry never re-signs, so it cannot become a second torrent entry', async () => {
    const pool = new FakePool({ relays: ['wss://relay.dtan.xyz'], failing: ['wss://relay.dtan.xyz'] });
    const { service, wallet } = await serviceWith(pool);

    const event = await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });
    const signCallsAfterBuild = wallet.calls.nostrSignEvent;

    await service.publishSignedEvent(event);
    await service.publishSignedEvent(event);
    await service.publishSignedEvent(event);

    assert.equal(wallet.calls.nostrSignEvent, signCallsAfterBuild, 'retries must not re-sign');
    assert.equal(new Set(pool.published.map((e) => e.id)).size, 1, 'one event id across every attempt');
});

test('rebuilding instead of retrying would produce a different event — the reason retries reuse it', async () => {
    let clock = 1_800_000_000_000;
    const wallet = makeWallet();
    await wallet.unlock();
    const service = new Web25RegistryService({ signer: wallet.signer, pool: new FakePool(), now: () => clock });

    const first = await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });
    clock += 60_000;
    const rebuilt = await service.createSignedRegistryEvent({ torrent: torrent(), chainArtifact: chainArtifact() });

    assert.notEqual(first.id, rebuilt.id);
    assert.notEqual(first.created_at, rebuilt.created_at);
    assert.equal(firstTagValue(first.tags, 'x'), firstTagValue(rebuilt.tags, 'x'), 'same infohash, two entries');
});

// ─── 5. Discovery ────────────────────────────────────────────────────────

test('the discovery query filters kind 2003 in the WEB25 website category', async () => {
    const pool = new FakePool();
    const { service } = await serviceWith(pool);

    service.subscribe(() => {});
    const [filter] = pool.subscriptions[0].filters;

    assert.deepEqual(filter.kinds, [NOSTR_REGISTRY_CONFIG.TORRENT_EVENT_KIND]);
    assert.deepEqual(filter['#i'], ['tcat:web25.cloud,websites']);
});

test('discovered entries expose the infohash needed by the normal WEB25 loader', async () => {
    const pool = new FakePool();
    const { service } = await serviceWith(pool);

    const seen = [];
    service.subscribe((result) => seen.push(result));
    pool.deliver(signedRegistryEvent());

    assert.equal(seen.length, 1);
    assert.equal(seen[0].infohash, INFOHASH);
    assert.equal(seen[0].npub, npubEncode(seen[0].nostrPubkey));
});

test('unrelated torrents delivered by a relay are ignored', async () => {
    const pool = new FakePool();
    const { service } = await serviceWith(pool);

    const seen = [];
    service.subscribe((result) => seen.push(result));

    pool.deliver(
        nostrCore.signEvent(
            {
                kind: 2003,
                created_at: 1800000000,
                tags: [['title', 'Linux ISO'], ['x', INFOHASH], ['i', 'tcat:software,linux']],
                content: ''
            },
            WALLET_PRIV.slice(2)
        )
    );

    assert.equal(seen.length, 0, 'a relay must not be able to inject other categories');
});

test('the same entry from several relays is surfaced once and records every relay', async () => {
    const pool = new FakePool();
    const { service } = await serviceWith(pool);

    const seen = [];
    const subscription = service.subscribe((result) => seen.push(result));

    const event = signedRegistryEvent();
    pool.deliver(event, 'wss://relay.dtan.xyz');
    pool.deliver(event, 'wss://nos.lol');
    pool.deliver(event, 'wss://relay.dtan.xyz');

    assert.equal(seen.length, 1, 'a duplicate must be rendered once');
    assert.deepEqual(subscription.results()[0].sourceRelays, ['wss://relay.dtan.xyz', 'wss://nos.lol']);
});

test('a bounded query returns verified results newest first', async () => {
    const pool = new FakePool();
    const { service } = await serviceWith(pool);

    const older = nostrCore.signEvent(
        { ...buildRegistryEventTemplate({ torrent: torrent(), chainArtifact: chainArtifact(), siteName: 'Older' }), created_at: 1000 },
        WALLET_PRIV.slice(2)
    );
    const newer = nostrCore.signEvent(
        { ...buildRegistryEventTemplate({ torrent: torrent(), chainArtifact: chainArtifact(), siteName: 'Newer' }), created_at: 2000 },
        WALLET_PRIV.slice(2)
    );

    // Connect first so the query registers its subscription synchronously,
    // exactly as the UI does before rendering the registry list.
    await service.connect();
    const pending = service.query({ timeoutMs: 20 });
    pool.deliver(older);
    pool.deliver(newer);

    const results = await pending;
    assert.deepEqual(results.map((r) => r.title), ['Newer', 'Older']);
    assert.equal(results[0].web25VerificationState, WEB25_VERIFICATION.VERIFIED);
    assert.equal(pool.subscriptions[0].closed, true, 'a query must not leak its subscription');
});

test('a query marks entries invalid when the mirrored EVM proof does not hold', async () => {
    const pool = new FakePool();
    const wallet = makeWallet();
    await wallet.unlock();
    const service = new Web25RegistryService({
        signer: wallet.signer,
        pool,
        verifyEvmSignature: async () => false
    });

    await service.connect();
    const pending = service.query({ timeoutMs: 20 });
    pool.deliver(signedRegistryEvent());

    const [result] = await pending;
    assert.equal(result.web25VerificationState, WEB25_VERIFICATION.INVALID);
});

test('closing the service closes its relay pool', async () => {
    const pool = new FakePool();
    const { service } = await serviceWith(pool);
    await service.connect();
    service.close();

    assert.equal(pool.closed, true);
    assert.equal(service.connected, false);
});
