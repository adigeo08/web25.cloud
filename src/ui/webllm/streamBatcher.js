// @ts-check
/**
 * Batched rendering for a streamed reply.
 *
 * The engine streams a delta per token or two — dozens a second — and drawing
 * each one means a DOM write, a layout and a scroll every time. This collapses
 * them: a delta only marks the reply as changed, and the reply is drawn at most
 * once per animation frame and no more often than every `intervalMs`. Nothing
 * is held here but *which* message changed: the text itself stays in the
 * controller's state and the flush reads all of it, so no token can be lost.
 *
 * Timing is injectable, so the throttle can be tested with a fake clock.
 */

/** About 15 updates a second: smooth to read, a fraction of the per-token work. */
export const STREAM_FLUSH_INTERVAL_MS = 66;

/**
 * @param {{ flush: (messageId: number) => void,
 *           intervalMs?: number,
 *           requestFrame?: (callback: () => void) => any,
 *           cancelFrame?: (handle: any) => void,
 *           now?: () => number,
 *           setTimer?: (callback: () => void, ms: number) => any,
 *           clearTimer?: (handle: any) => void }} options
 */
export function createStreamBatcher({
    flush,
    intervalMs = STREAM_FLUSH_INTERVAL_MS,
    requestFrame = (callback) =>
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : setTimeout(callback, 16),
    cancelFrame = (handle) =>
        typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(handle) : clearTimeout(handle),
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(handle)
}) {
    /** @type {number|null} the message waiting to be drawn */
    let pending = null;
    let frame = null;
    let timer = null;
    let lastFlush = -Infinity;
    let flushes = 0;

    function run() {
        frame = null;
        const id = pending;
        pending = null;
        if (id === null) return;
        lastFlush = now();
        flushes += 1;
        flush(id);
    }

    function arm() {
        if (frame !== null || timer !== null) return;
        const wait = intervalMs - (now() - lastFlush);
        if (wait > 0) {
            timer = setTimer(() => {
                timer = null;
                frame = requestFrame(run);
            }, wait);
        } else {
            frame = requestFrame(run);
        }
    }

    function clear() {
        if (frame !== null) cancelFrame(frame);
        if (timer !== null) clearTimer(timer);
        frame = null;
        timer = null;
    }

    return {
        /** A message's text changed; draw it soon. */
        schedule(messageId) {
            // A different message (a new reply already streaming) gets the old one drawn first.
            if (pending !== null && pending !== messageId) this.flushNow();
            pending = messageId;
            arm();
        },
        /** Draw now whatever is waiting. */
        flushNow() {
            clear();
            run();
        },
        /** Forget whatever is waiting: a full render is about to draw everything anyway. */
        cancel() {
            clear();
            pending = null;
        },
        get pending() {
            return pending;
        },
        /** How many times the reply has been drawn — for tests and measurements. */
        get flushes() {
            return flushes;
        }
    };
}
