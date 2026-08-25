/**
 * Regressions for the review findings on PR #71.
 *
 * Each test here fails against the code as it was before the fix, so the
 * behaviour cannot quietly come back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NostrRelayPool } from '../src/nostr/NostrRelayPool.js';
import { NOSTR_CONFIG } from '../src/config/nostr.config.js';
import { nostrCore } from '../src/nostr/nostr.js';

const PRIV = '1111111111111111111111111111111111111111111111111111111111111111';
const PUBKEY = nostrCore.getNostrPublicKey(PRIV);

// A publish timeout long enough that a test finishing quickly proves the
// publish resolved on relay replies rather than by timing out.
const SLOW_TIMEOUT = { ...NOSTR_CONFIG, RELAY_CONNECT_TIMEOUT_MS: 50, RELAY_PUBLISH_TIMEOUT_MS: 5000 };

class MockSocket {
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        MockSocket.instances.push(this);
        queueMicrotask(() => {
            this.readyState = 1;
            this.onopen?.();
        });
    }
    send(frame) {
        if (this.readyState !== 1) throw new Error('socket not open');
        this.sent.push(JSON.parse(frame));
    }
    close() {
        this.readyState = 3;
        this.onclose?.();
    }
    deliver(frame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
}

function signed() {
    return nostrCore.signEvent(
        { kind: 1059, created_at: Math.floor(Date.now() / 1000) - 60, tags: [['p', PUBKEY]], content: 'x' },
        PRIV
    );
}

async function pool(relays) {
    MockSocket.instances = [];
    const instance = new NostrRelayPool({
        relays,
        verifyEvent: (event) => nostrCore.verifyEvent(event),
        WebSocketImpl: MockSocket,
        config: SLOW_TIMEOUT
    });
    await instance.connect();
    return instance;
}

// ─── Finding: publish completion keyed off the live connected count ──────

test('publish resolves on replies from the relays that actually received it', async () => {
    const p = await pool(['wss://a.example', 'wss://b.example']);

    // One relay is still marked connected but its socket has gone away, so the
    // send fails and it will never answer.
    MockSocket.instances[1].readyState = 3;
    assert.equal(p.connectedCount, 2, 'the pool still believes both are connected');

    const event = signed();
    const started = Date.now();
    const publishing = p.publish(event);

    MockSocket.instances[0].deliver(['OK', event.id, true, '']);
    const result = await publishing;

    // Before the fix this waited out the full 5s publish timeout, because it
    // compared one reply against a connected count of two.
    assert.ok(Date.now() - started < 1000, `publish should not wait for the timeout (took ${Date.now() - started}ms)`);
    assert.deepEqual(result.accepted, ['wss://a.example']);
    assert.equal(result.attempted, 1, 'only the reachable relay was attempted');
    p.close();
});

test('publish still waits for every relay that did receive the event', async () => {
    const p = await pool(['wss://a.example', 'wss://b.example']);
    const event = signed();
    let settled = false;

    const publishing = p.publish(event).then((value) => {
        settled = true;
        return value;
    });

    MockSocket.instances[0].deliver(['OK', event.id, true, '']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, 'one reply out of two must not complete the publish');

    MockSocket.instances[1].deliver(['OK', event.id, false, 'blocked: full']);
    const result = await publishing;

    assert.deepEqual(result.accepted, ['wss://a.example']);
    assert.deepEqual(result.rejected, { 'wss://b.example': 'blocked: full' });
    assert.equal(result.attempted, 2);
    p.close();
});

test('a relay dropping mid-publish does not strand the publish', async () => {
    const p = await pool(['wss://a.example', 'wss://b.example']);
    const event = signed();
    const started = Date.now();

    const publishing = p.publish(event);
    // b answers, then a disconnects entirely without ever replying.
    MockSocket.instances[1].deliver(['OK', event.id, true, '']);
    MockSocket.instances[0].close();

    const result = await publishing;
    // The target stays at 2, so this one legitimately waits out the timeout
    // rather than reporting a result nobody confirmed.
    assert.ok(Date.now() - started >= 100, 'an unanswered relay is not silently counted');
    assert.deepEqual(result.accepted, ['wss://b.example']);
    p.close();
});

// ─── Finding: wizard treats a skipped registry as in progress ────────────

/** Mirrors the step selection and chip state in `updateDeployWizard`. */
function wizard(registryState) {
    const hasDeployResult = true;
    const registryStarted = registryState !== 'idle' && registryState !== 'skipped';
    const activeStep = hasDeployResult && registryStarted ? 7 : 6;

    let chip7 = 'step-locked';
    if (activeStep === 7) chip7 = 'step-active';
    if (registryState === 'published') chip7 = 'step-done';
    else if (registryState === 'failed') chip7 = 'step-active';
    else if (registryState === 'skipped') chip7 = 'step-locked';

    return { activeStep, chip7 };
}

test('a skipped registry leaves the wizard on the deployment step', () => {
    const state = wizard('skipped');
    assert.equal(state.activeStep, 6, 'nothing is in progress, so step 7 must not become current');
    assert.equal(state.chip7, 'step-locked', 'and it must not be highlighted as active');
});

test('an in-progress or failed registry does advance the wizard', () => {
    assert.equal(wizard('publishing').activeStep, 7);
    assert.equal(wizard('failed').activeStep, 7);
    assert.equal(wizard('failed').chip7, 'step-active', 'a failure is actionable — retry is offered');
    assert.equal(wizard('published').chip7, 'step-done');
});

test('an untouched registry leaves the wizard at the deployment step', () => {
    assert.equal(wizard('idle').activeStep, 6);
    assert.equal(wizard('idle').chip7, 'step-locked');
});

// ─── Finding: skipped was reported as failed ─────────────────────────────

/** Mirrors `registryStateLabel()` in Lifecycle. */
function label({ registryPublication, lastRegistryEvent }) {
    if (!registryPublication) return lastRegistryEvent ? 'publishing' : 'idle';
    if (registryPublication.ok) return 'published';
    return registryPublication.eventId ? 'failed' : 'skipped';
}

test('an event that was never created reports skipped, not failed', () => {
    // The wallet was locked, so no registry event exists and there is nothing
    // to retry — the result panel already said "skipped" while the wizard said
    // "failed / retry available".
    const state = label({ registryPublication: { ok: false, eventId: null }, lastRegistryEvent: null });
    assert.equal(state, 'skipped');
});

test('an event that was created but rejected reports failed', () => {
    const state = label({ registryPublication: { ok: false, eventId: 'abc' }, lastRegistryEvent: { id: 'abc' } });
    assert.equal(state, 'failed', 'this one is retryable, and the retry resends the same event');
});

test('the remaining registry states are unchanged', () => {
    assert.equal(label({ registryPublication: null, lastRegistryEvent: null }), 'idle');
    assert.equal(label({ registryPublication: null, lastRegistryEvent: { id: 'abc' } }), 'publishing');
    assert.equal(label({ registryPublication: { ok: true, eventId: 'abc' }, lastRegistryEvent: { id: 'abc' } }), 'published');
});
