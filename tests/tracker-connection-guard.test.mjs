/**
 * The cap on the tracker WebSocket reconnect loop.
 *
 * `bittorrent-tracker` reconnects to a tracker that refuses or drops the socket
 * for as long as the torrent lives, and exposes no option to stop. The guard
 * applies the cap from outside by destroying a tracker that has failed twice in
 * a row, and is deliberately defensive: a tracker object it does not recognise
 * is left alone rather than throwing at the torrent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    attachTrackerConnectionGuard,
    TRACKER_MAX_CONNECT_FAILURES
} from '../src/core/torrent/TrackerConnectionGuard.js';

/** A stand-in for one `WebSocketTracker`. */
function fakeTracker(announceUrl) {
    return {
        announceUrl,
        destroyed: false,
        reconnecting: false,
        retries: 0,
        socket: null,
        destroy() {
            this.destroyed = true;
        }
    };
}

function fakeTorrent(trackers) {
    const events = new Map();
    return {
        discovery: { tracker: { _trackers: trackers } },
        once(name, handler) {
            events.set(name, handler);
        },
        emit(name) {
            events.get(name)?.();
        }
    };
}

/** Attach with manual sweeps: the test drives the clock, not a real interval. */
function guardOf(torrent, options = {}) {
    const timers = [];
    return attachTrackerConnectionGuard(torrent, {
        setIntervalImpl: (fn) => {
            timers.push(fn);
            return timers.length;
        },
        clearIntervalImpl: () => timers.splice(0, timers.length),
        ...options
    });
}

test('a tracker is destroyed after two failed connection attempts', () => {
    const tracker = fakeTracker('wss://tracker.example');
    const guard = guardOf(fakeTorrent([tracker]));

    // First attempt failed: the library is now waiting to retry.
    tracker.reconnecting = true;
    tracker.retries = 0;
    guard.sweep();
    assert.equal(tracker.destroyed, false, 'one failure is not enough to give up');

    // The retry ran and failed too.
    tracker.retries = 1;
    guard.sweep();
    assert.equal(tracker.destroyed, true);
    assert.equal(TRACKER_MAX_CONNECT_FAILURES, 2);
});

test('an attempt still in flight is not counted as a failure', () => {
    const tracker = fakeTracker('wss://tracker.example');
    const guard = guardOf(fakeTorrent([tracker]));

    tracker.reconnecting = false;
    tracker.retries = 5;
    guard.sweep();
    guard.sweep();

    assert.equal(tracker.destroyed, false);
});

test('a connected tracker gets its budget back', () => {
    const tracker = fakeTracker('wss://tracker.example');
    const guard = guardOf(fakeTorrent([tracker]));

    tracker.reconnecting = true;
    guard.sweep();

    tracker.socket = { connected: true };
    tracker.reconnecting = false;
    tracker.retries = 0;
    guard.sweep();

    // A drop after that working session starts the count from zero again.
    tracker.socket = null;
    tracker.reconnecting = true;
    guard.sweep();
    assert.equal(tracker.destroyed, false, 'the first failure after a good session is only the first');
});

test('an open socket reported the other way round is still connected', () => {
    const tracker = fakeTracker('wss://tracker.example');
    const guard = guardOf(fakeTorrent([tracker]));

    tracker.socket = { _ws: { readyState: 1 } };
    tracker.reconnecting = true;
    tracker.retries = 9;
    guard.sweep();

    assert.equal(tracker.destroyed, false);
});

test('trackers are counted one by one', () => {
    const dead = fakeTracker('wss://dead.example');
    const alive = fakeTracker('wss://alive.example');
    alive.socket = { connected: true };
    const guard = guardOf(fakeTorrent([dead, alive]));

    dead.reconnecting = true;
    dead.retries = 1;
    guard.sweep();

    assert.equal(dead.destroyed, true);
    assert.equal(alive.destroyed, false, 'a working tracker is untouched');
});

test('a tracker library that looks nothing like the expected one is left alone', () => {
    const odd = { announceUrl: 'wss://odd.example', reconnecting: true, retries: undefined };
    const guard = guardOf(fakeTorrent([odd]));

    guard.sweep();
    guard.sweep();

    // Two transitions were counted, and destroying it is simply not possible;
    // what matters is that the guard did not throw at the caller.
    assert.equal(odd.destroyed, undefined);
});

test('the caller is told once when no tracker is left', () => {
    const first = fakeTracker('wss://one.example');
    const second = fakeTracker('wss://two.example');
    let exhausted = 0;
    const guard = guardOf(fakeTorrent([first, second]), { onExhausted: () => (exhausted += 1) });

    first.reconnecting = true;
    first.retries = 1;
    guard.sweep();
    assert.equal(exhausted, 0, 'one dead tracker is not the end of the transport');

    second.reconnecting = true;
    second.retries = 1;
    guard.sweep();
    assert.equal(exhausted, 1);

    guard.sweep();
    assert.equal(exhausted, 1, 'and it is not repeated');
});

test('the guard stops with the torrent', () => {
    const tracker = fakeTracker('wss://tracker.example');
    const torrent = fakeTorrent([tracker]);
    const guard = guardOf(torrent);

    torrent.emit('close');
    tracker.reconnecting = true;
    tracker.retries = 5;
    guard.sweep();

    assert.equal(tracker.destroyed, false, 'a stopped guard does nothing at all');
});

test('a torrent with no discovery layer yet is not an error', () => {
    const guard = guardOf({ once() {} });
    guard.sweep();
    guard.stop();
});
