// @ts-check
/**
 * A cap on the tracker WebSocket reconnect loop.
 *
 * WebTorrent announces over `wss://` trackers through `bittorrent-tracker`,
 * which reconnects to a tracker that refuses or drops the socket for as long as
 * the torrent lives — exponential backoff, but no end. When a tracker is simply
 * down that is a WebSocket the browser opens, fails and logs every few seconds,
 * for every torrent in the client, behind a page that has long since fallen back
 * to the mirror.
 *
 * The library exposes no option for this, so the cap is applied from outside:
 * the guard watches the tracker objects the discovery layer holds and destroys
 * one once it has failed `maxFailures` connection attempts in a row. Destroying
 * a tracker clears its reconnect timer and takes it out of the announce loop;
 * the torrent keeps whatever other trackers and peers it has.
 *
 * A tracker that connects resets its own count: a drop after a working session
 * is not a failed connection attempt, and that tracker gets its full budget
 * again.
 *
 * Everything the guard touches on the tracker object is read defensively. This
 * is `bittorrent-tracker` internals, and the guard is written to do nothing at
 * all rather than throw if a future version renames them.
 */

/** Consecutive failed connection attempts before a tracker is given up on. */
export const TRACKER_MAX_CONNECT_FAILURES = 2;

/** How often the tracker set is inspected. */
export const TRACKER_SWEEP_INTERVAL_MS = 4000;

/**
 * @param {any} torrent a WebTorrent torrent
 * @returns {any[]} the tracker objects backing its announces
 */
function trackersOf(torrent) {
    const trackers = torrent?.discovery?.tracker?._trackers;
    return Array.isArray(trackers) ? trackers : [];
}

/**
 * @param {any} tracker
 * @returns {boolean} whether its WebSocket is open right now
 */
function isTrackerConnected(tracker) {
    const socket = tracker?.socket;
    if (!socket) return false;
    if (socket.connected === true) return true;
    const ws = socket._ws || socket.ws;
    return Boolean(ws && ws.readyState === 1);
}

/**
 * @param {any} torrent
 * @param {{
 *   maxFailures?: number,
 *   intervalMs?: number,
 *   log?: (message: string) => void,
 *   onExhausted?: () => void,
 *   setIntervalImpl?: typeof setInterval,
 *   clearIntervalImpl?: typeof clearInterval
 * }} [options]
 * @returns {{ sweep: () => void, stop: () => void }}
 */
export function attachTrackerConnectionGuard(torrent, options = {}) {
    const {
        maxFailures = TRACKER_MAX_CONNECT_FAILURES,
        intervalMs = TRACKER_SWEEP_INTERVAL_MS,
        log = () => {},
        onExhausted = () => {},
        setIntervalImpl = setInterval,
        clearIntervalImpl = clearInterval
    } = options;

    /** @type {Map<string, { failures: number, reconnecting: boolean }>} */
    const state = new Map();
    let stopped = false;

    const sweep = () => {
        if (stopped) return;
        for (const tracker of trackersOf(torrent)) {
            if (!tracker || tracker.destroyed) continue;
            const url = `${tracker.announceUrl || ''}`;
            const entry = state.get(url) || { failures: 0, reconnecting: false };
            state.set(url, entry);

            if (isTrackerConnected(tracker)) {
                entry.failures = 0;
                entry.reconnecting = false;
                continue;
            }
            // Not reconnecting and not connected means an attempt is still in
            // flight; it has not failed yet.
            if (tracker.reconnecting !== true) {
                entry.reconnecting = false;
                continue;
            }

            if (Number.isFinite(tracker.retries)) {
                // The library counts completed retries; the attempt that put it
                // into `reconnecting` is one more failure than that.
                entry.failures = Number(tracker.retries) + 1;
            } else if (!entry.reconnecting) {
                entry.failures += 1;
            }
            entry.reconnecting = true;

            if (entry.failures < maxFailures) continue;
            log(`[Trackers] ${url || 'tracker'} failed ${entry.failures} connection attempts; not retrying it.`);
            try {
                tracker.destroy();
            } catch (_) {
                // A tracker that cannot be destroyed is left alone: the guard
                // must never take the torrent down with it.
            }
        }

        // With every tracker given up on there is no way left to find a peer,
        // and nothing will emit `noPeers` to say so. The caller is told once,
        // so the load can end instead of waiting out its whole timeout.
        const trackers = trackersOf(torrent);
        if (trackers.length === 0 || !trackers.every((tracker) => tracker?.destroyed)) return;
        log('[Trackers] No tracker is reachable; giving up on the WebRTC transport.');
        stop();
        try {
            onExhausted();
        } catch (_) {
            // The guard reports; what the caller does with it is its own.
        }
    };

    /** @type {any} */
    let timer = null;
    function stop() {
        if (stopped) return;
        stopped = true;
        if (timer !== null) clearIntervalImpl(timer);
        state.clear();
    }

    timer = setIntervalImpl(sweep, intervalMs);
    if (typeof timer?.unref === 'function') timer.unref();

    try {
        torrent?.once?.('close', stop);
        torrent?.once?.('done', stop);
    } catch (_) {
        // A torrent-shaped stub without events is fine; `stop()` still works.
    }

    return { sweep, stop };
}
