/**
 * How hard the pool tries to open a relay socket.
 *
 * A relay that refuses the connection is not going to accept the hundredth
 * attempt either, and every attempt is a WebSocket the browser opens, fails and
 * logs. Two consecutive failures end the automatic retries; a relay that
 * actually connected keeps its full budget, because a drop after a working
 * session is a different thing from a relay that is not there.
 *
 * The other property pinned here is that a relay never has two connection
 * attempts in flight at once: a scheduled retry and an explicit `connect()`
 * must not each open a socket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NostrRelayPool } from '../src/nostr/NostrRelayPool.js';
import { NOSTR_CONFIG } from '../src/config/nostr.config.js';

const URL = 'wss://relay.example';
const FAST = { ...NOSTR_CONFIG, RELAY_CONNECT_TIMEOUT_MS: 20, RELAY_RECONNECT_MIN_MS: 1, RELAY_RECONNECT_MAX_MS: 2 };

/** A socket that fails or opens on command, and counts how many were made. */
function socketFactory({ behaviour }) {
    const made = [];
    class Socket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            this.onopen = null;
            this.onerror = null;
            this.onclose = null;
            this.onmessage = null;
            made.push(this);
            queueMicrotask(() => {
                if (behaviour(made.length) === 'open') {
                    this.readyState = 1;
                    this.onopen?.();
                    return;
                }
                this.readyState = 3;
                this.onerror?.({ message: 'connection refused' });
                this.onclose?.();
            });
        }
        send(frame) {
            this.sent.push(JSON.parse(frame));
        }
        close() {
            if (this.readyState === 3) return;
            this.readyState = 3;
            this.onclose?.();
        }
    }
    return { Socket, made };
}

const settle = async (rounds = 40) => {
    for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
};

const poolWith = (Socket, config = FAST) =>
    new NostrRelayPool({ relays: [URL], verifyEvent: () => true, WebSocketImpl: Socket, config });

test('two failed connection attempts end the retries', async () => {
    const { Socket, made } = socketFactory({ behaviour: () => 'fail' });
    const pool = poolWith(Socket);

    await pool.connect();
    await settle();

    assert.equal(made.length, 2, 'the relay was tried twice and then left alone');
    assert.equal(pool.status[0].status, 'unavailable');
    pool.close();
});

test('the cap is the configured one', async () => {
    const { Socket, made } = socketFactory({ behaviour: () => 'fail' });
    const pool = poolWith(Socket, { ...FAST, RELAY_MAX_CONNECT_FAILURES: 4 });

    await pool.connect();
    await settle();

    assert.equal(made.length, 4);
    pool.close();
});

test('a relay that connects and then drops keeps its full budget', async () => {
    // Opens, then every later attempt fails: the drop is not a failed attempt,
    // so the two that follow it are.
    const { Socket, made } = socketFactory({ behaviour: (count) => (count === 1 ? 'open' : 'fail') });
    const pool = poolWith(Socket);

    await pool.connect();
    assert.equal(pool.connectedCount, 1);
    made[0].close();
    await settle();

    assert.equal(made.length, 3, 'one good socket, then two attempts before giving up');
    assert.equal(pool.status[0].status, 'unavailable');
    pool.close();
});

test('a relay that keeps answering is never given up on', async () => {
    const { Socket, made } = socketFactory({ behaviour: () => 'open' });
    const pool = poolWith(Socket);

    await pool.connect();
    made[0].close();
    await settle(10);
    assert.equal(pool.connectedCount, 1, 'it reconnected');
    made[made.length - 1].close();
    await settle(10);

    assert.equal(pool.connectedCount, 1);
    assert.ok(pool.status[0].status !== 'unavailable');
    pool.close();
});

test('one relay never has two connection attempts in flight', async () => {
    // A scheduled retry is pending while `connect()` is called again; only one
    // socket may come out of that.
    const { Socket, made } = socketFactory({ behaviour: () => 'fail' });
    const pool = poolWith(Socket, { ...FAST, RELAY_RECONNECT_MIN_MS: 60, RELAY_RECONNECT_MAX_MS: 60 });

    await pool.connect();
    assert.equal(made.length, 1);
    await pool.connect();
    assert.equal(made.length, 2, 'the second attempt replaced the scheduled retry rather than joining it');

    await settle();
    assert.equal(made.length, 2, 'and the retry it cancelled never fired');
    pool.close();
});

test('calling connect() again is a deliberate retry of a relay that was given up on', async () => {
    const { Socket, made } = socketFactory({ behaviour: (count) => (count > 2 ? 'open' : 'fail') });
    const pool = poolWith(Socket);

    await pool.connect();
    await settle();
    assert.equal(pool.status[0].status, 'unavailable');

    await pool.connect();
    assert.equal(pool.connectedCount, 1, 'the application asking again gets a fresh set of attempts');
    assert.equal(made.length, 3);
    pool.close();
});

test('closing the pool stops the retries', async () => {
    const { Socket, made } = socketFactory({ behaviour: () => 'fail' });
    const pool = poolWith(Socket, { ...FAST, RELAY_RECONNECT_MIN_MS: 5, RELAY_RECONNECT_MAX_MS: 5 });

    await pool.connect();
    pool.close();
    const afterClose = made.length;
    await settle();

    assert.equal(made.length, afterClose);
});
