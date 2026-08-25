/**
 * Relay pool behaviour.
 *
 * The pool is the whole networking layer of the Nostr side: the browser talks
 * to public relays over plain WebSockets, with no proxy and no Web25-operated
 * relay in between. These tests pin the properties that makes safe:
 * a relay is never an authority, no single relay is required, and duplicates
 * across relays are collapsed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NostrRelayPool, eventMatchesFilter, normalizeRelayUrls } from '../src/nostr/NostrRelayPool.js';
import { DEFAULT_NOSTR_RELAYS, NOSTR_CONFIG } from '../src/config/nostr.config.js';
import { nostrCore } from '../src/nostr/nostr.js';

const PRIV = '1111111111111111111111111111111111111111111111111111111111111111';
const OTHER_PRIV = '2222222222222222222222222222222222222222222222222222222222222222';
const PUBKEY = nostrCore.getNostrPublicKey(PRIV);

const FAST_CONFIG = { ...NOSTR_CONFIG, RELAY_CONNECT_TIMEOUT_MS: 50, RELAY_PUBLISH_TIMEOUT_MS: 50 };

/** Minimal in-memory WebSocket double. */
class MockSocket {
    /** @type {MockSocket[]} */
    static instances = [];

    constructor(url, { failOnConnect = false } = {}) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.onopen = null;
        this.onerror = null;
        this.onclose = null;
        this.onmessage = null;
        MockSocket.instances.push(this);
        if (!failOnConnect) queueMicrotask(() => this.open());
    }

    open() {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.();
    }

    fail(message = 'refused') {
        this.readyState = 3;
        this.onerror?.({ message });
    }

    send(frame) {
        this.sent.push(JSON.parse(frame));
    }

    close() {
        this.readyState = 3;
        this.onclose?.();
    }

    /** Simulate a relay pushing a frame at us. */
    deliver(frame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }

    deliverRaw(data) {
        this.onmessage?.({ data });
    }

    sentOfType(type) {
        return this.sent.filter((frame) => frame[0] === type);
    }
}

function socketFactory({ failing = [] } = {}) {
    MockSocket.instances = [];
    return class ScriptedSocket extends MockSocket {
        constructor(url) {
            super(url, { failOnConnect: failing.includes(url) });
            if (failing.includes(url)) queueMicrotask(() => this.fail('connection refused'));
        }
    };
}

function signed(overrides = {}, privateKey = PRIV) {
    return nostrCore.signEvent(
        {
            kind: 1059,
            created_at: Math.floor(Date.now() / 1000) - 60,
            tags: [['p', PUBKEY]],
            content: 'wrapped',
            ...overrides
        },
        privateKey
    );
}

async function connectedPool(options = {}) {
    const pool = new NostrRelayPool({
        relays: ['wss://a.example', 'wss://b.example', 'wss://c.example'],
        verifyEvent: (event) => nostrCore.verifyEvent(event),
        config: FAST_CONFIG,
        ...options
    });
    await pool.connect();
    return pool;
}

// ─── configuration ───────────────────────────────────────────────────────

test('the default relay pool is the documented set of public relays', () => {
    assert.deepEqual(
        [...DEFAULT_NOSTR_RELAYS],
        ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band', 'wss://relay.snort.social']
    );
});

test('relay URLs are normalized, deduplicated and restricted to wss://', () => {
    assert.deepEqual(
        normalizeRelayUrls(['wss://a.example/', 'wss://a.example', 'ws://insecure.example', 'http://nope', '', null]),
        ['wss://a.example']
    );
});

test('a pool with no usable relay URL cannot be constructed', () => {
    assert.throws(
        () => new NostrRelayPool({ relays: ['ws://insecure'], verifyEvent: () => true }),
        /at least one Nostr relay/i
    );
});

// ─── failure tolerance ───────────────────────────────────────────────────

test('unreachable relays are tolerated: one working relay is enough', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory({ failing: ['wss://a.example', 'wss://b.example'] }) });

    assert.equal(pool.connectedCount, 1);
    assert.deepEqual(
        pool.status.map((entry) => entry.status),
        ['error', 'error', 'connected']
    );

    const event = signed();
    const result = await pool.publish(event);
    assert.equal(result.attempted, 1);
    pool.close();
});

test('publishing fails loudly when no relay is reachable at all', async () => {
    const pool = await connectedPool({
        WebSocketImpl: socketFactory({ failing: ['wss://a.example', 'wss://b.example', 'wss://c.example'] })
    });
    await assert.rejects(() => pool.publish(signed()), /no Nostr relay is currently reachable/i);
    pool.close();
});

test('publish reports which relays accepted and which rejected', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const event = signed();

    const publishing = pool.publish(event);
    const [a, b, c] = MockSocket.instances;
    a.deliver(['OK', event.id, true, '']);
    b.deliver(['OK', event.id, false, 'blocked: rate limited']);
    c.deliver(['OK', event.id, true, '']);

    const result = await publishing;
    assert.deepEqual(result.accepted.sort(), ['wss://a.example', 'wss://c.example']);
    assert.deepEqual(result.rejected, { 'wss://b.example': 'blocked: rate limited' });
    pool.close();
});

test('the pool refuses to publish an event that fails local verification', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const event = { ...signed(), content: 'tampered' };
    await assert.rejects(() => pool.publish(event), /fails local verification/i);
    pool.close();
});

// ─── never trust a relay ─────────────────────────────────────────────────

test('events that fail signature verification are dropped', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const received = [];
    const sub = pool.subscribe([{ kinds: [1059], '#p': [PUBKEY] }], (event) => received.push(event));

    const good = signed();
    MockSocket.instances[0].deliver(['EVENT', sub.id, { ...good, content: 'tampered' }]);
    MockSocket.instances[0].deliver(['EVENT', sub.id, { ...good, sig: 'f'.repeat(128) }]);
    MockSocket.instances[0].deliver(['EVENT', sub.id, good]);

    assert.equal(received.length, 1);
    assert.equal(received[0].id, good.id);
    pool.close();
});

test('events that do not match the requested filter are dropped', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const received = [];
    const sub = pool.subscribe([{ kinds: [1059], '#p': [PUBKEY] }], (event) => received.push(event));

    // Right shape, wrong kind.
    MockSocket.instances[0].deliver(['EVENT', sub.id, signed({ kind: 1 })]);
    // Right kind, addressed to somebody else.
    MockSocket.instances[0].deliver(['EVENT', sub.id, signed({ tags: [['p', 'a'.repeat(64)]] })]);
    // Signed by another key, but still matching — authorship is not filtered here.
    const otherAuthor = signed({}, OTHER_PRIV);
    MockSocket.instances[0].deliver(['EVENT', sub.id, otherAuthor]);

    assert.deepEqual(received.map((event) => event.id), [otherAuthor.id]);
    pool.close();
});

test('events for an unknown subscription id are ignored', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const received = [];
    pool.subscribe([{ kinds: [1059] }], (event) => received.push(event));

    MockSocket.instances[0].deliver(['EVENT', 'not-our-subscription', signed()]);
    assert.equal(received.length, 0);
    pool.close();
});

test('far-future events are rejected regardless of a valid signature', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const received = [];
    const sub = pool.subscribe([{ kinds: [1059] }], (event) => received.push(event));

    const future = signed({ created_at: Math.floor(Date.now() / 1000) + 3 * 60 * 60 });
    MockSocket.instances[0].deliver(['EVENT', sub.id, future]);
    assert.equal(received.length, 0);
    pool.close();
});

test('malformed frames never reach the application', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const received = [];
    const sub = pool.subscribe([{ kinds: [1059] }], (event) => received.push(event));

    MockSocket.instances[0].deliverRaw('not json at all');
    MockSocket.instances[0].deliverRaw(JSON.stringify({ not: 'an array' }));
    MockSocket.instances[0].deliverRaw(JSON.stringify(['EVENT']));
    MockSocket.instances[0].deliverRaw(JSON.stringify(['EVENT', sub.id, null]));
    MockSocket.instances[0].deliverRaw(JSON.stringify(['EVENT', sub.id, { id: 1 }]));
    MockSocket.instances[0].deliverRaw('x'.repeat(NOSTR_CONFIG.MAX_RELAY_FRAME_BYTES + 1));

    assert.equal(received.length, 0);
    pool.close();
});

// ─── deduplication ───────────────────────────────────────────────────────

test('the same event arriving from every relay is delivered exactly once', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const received = [];
    const sub = pool.subscribe([{ kinds: [1059], '#p': [PUBKEY] }], (event) => received.push(event));

    const event = signed();
    for (const socket of MockSocket.instances) socket.deliver(['EVENT', sub.id, event]);
    // And a second copy from the relay that was first.
    MockSocket.instances[0].deliver(['EVENT', sub.id, event]);

    assert.equal(received.length, 1);
    pool.close();
});

test('distinct events are all delivered', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const received = [];
    const sub = pool.subscribe([{ kinds: [1059], '#p': [PUBKEY] }], (event) => received.push(event));

    const first = signed({ content: 'one' });
    const second = signed({ content: 'two' });
    MockSocket.instances[0].deliver(['EVENT', sub.id, first]);
    MockSocket.instances[1].deliver(['EVENT', sub.id, second]);

    assert.deepEqual(received.map((event) => event.content).sort(), ['one', 'two']);
    pool.close();
});

// ─── subscription lifecycle ──────────────────────────────────────────────

test('a subscription is broadcast to every connected relay and closed on every one', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const sub = pool.subscribe([{ kinds: [1059], '#p': [PUBKEY] }], () => {});

    for (const socket of MockSocket.instances) {
        assert.equal(socket.sentOfType('REQ').length, 1);
        assert.equal(socket.sentOfType('REQ')[0][1], sub.id);
    }

    sub.close();
    for (const socket of MockSocket.instances) {
        assert.deepEqual(socket.sentOfType('CLOSE')[0], ['CLOSE', sub.id]);
    }
    pool.close();
});

test('a closed subscription delivers nothing further', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const received = [];
    const sub = pool.subscribe([{ kinds: [1059] }], (event) => received.push(event));
    sub.close();

    MockSocket.instances[0].deliver(['EVENT', sub.id, signed()]);
    assert.equal(received.length, 0);
    pool.close();
});

test('close() tears down every subscription and socket', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    pool.subscribe([{ kinds: [1059] }], () => {});
    pool.close();

    assert.equal(pool.subscriptions.size, 0);
    assert.equal(pool.relays.size, 0);
    for (const socket of MockSocket.instances) {
        assert.equal(socket.readyState, 3);
        assert.equal(socket.onmessage, null);
    }
    assert.throws(() => pool.subscribe([{ kinds: [1] }], () => {}), /closed/i);
});

test('a handler that throws does not break the pool', async () => {
    const pool = await connectedPool({ WebSocketImpl: socketFactory() });
    const sub = pool.subscribe([{ kinds: [1059] }], () => {
        throw new Error('handler blew up');
    });
    MockSocket.instances[0].deliver(['EVENT', sub.id, signed()]);
    assert.equal(pool.connectedCount, 3);
    pool.close();
});

// ─── filter matching ─────────────────────────────────────────────────────

test('eventMatchesFilter honours kinds, authors, tags and time bounds', () => {
    const event = { id: 'a', pubkey: 'b', kind: 1059, created_at: 100, tags: [['p', 'x']], content: '' };

    assert.equal(eventMatchesFilter(event, { kinds: [1059] }), true);
    assert.equal(eventMatchesFilter(event, { kinds: [14] }), false);
    assert.equal(eventMatchesFilter(event, { authors: ['b'] }), true);
    assert.equal(eventMatchesFilter(event, { authors: ['z'] }), false);
    assert.equal(eventMatchesFilter(event, { ids: ['a'] }), true);
    assert.equal(eventMatchesFilter(event, { ids: ['z'] }), false);
    assert.equal(eventMatchesFilter(event, { '#p': ['x'] }), true);
    assert.equal(eventMatchesFilter(event, { '#p': ['y'] }), false);
    assert.equal(eventMatchesFilter(event, { since: 50, until: 150 }), true);
    assert.equal(eventMatchesFilter(event, { since: 150 }), false);
    assert.equal(eventMatchesFilter(event, { until: 50 }), false);
});
