// @ts-check
/**
 * Where the user was, and whether they were signed in when the page went away.
 *
 * The wallet session lives inside the signing worker and dies with the page, by
 * design: a reload, a `window.location` navigation or a closed tab all end it,
 * and nothing outside the worker ever holds the key to bring it back. What the
 * user loses along with it is their place — they come back to the landing tab
 * with no explanation of why the thing they were doing is gone.
 *
 * This hint is the smallest possible fix for that, and deliberately nothing
 * more. It records two facts:
 *
 *   `tab`         which tab was open, from a fixed list of tab names;
 *   `wasUnlocked` whether a session was live when the page was last used.
 *
 * There is no address here, no public key, no npub, no deployment hash and
 * nothing derived from any of them — it is a breadcrumb, not a session. It
 * cannot unlock anything, cannot identify whose browser it is, and the wallet
 * still needs a passkey exactly as before. That is the whole point: knowing you
 * have to unlock again is useful, and is not a reason to keep anything
 * sensitive in `localStorage`.
 */

const STORAGE_KEY = 'web25.session.tab.v1';

/** A stale breadcrumb is worse than none: a day later, "carry on" is noise. */
export const RESUME_HINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** The only tab names that may be written. An unknown one is dropped. */
export const RESUMABLE_TABS = Object.freeze(['browse', 'publish', 'pages', 'auth', 'channels', 'about']);

/**
 * @typedef {{ tab: string, wasUnlocked: boolean, savedAt: number }} ResumeHint
 */

function readRaw() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        // Private mode, disabled storage, or somebody else's JSON in our key.
        return null;
    }
}

function write(hint) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(hint));
        return true;
    } catch (_) {
        // Storage being unavailable costs a convenience, never a session.
        return false;
    }
}

/**
 * The stored record, normalised.
 *
 * The tab and the session flag carry their own timestamps on purpose. They age
 * for different reasons: moving between tabs is not news about the wallet, and
 * a flag that renewed itself every time the tab changed would keep announcing
 * an interruption that happened yesterday — which is exactly what happened when
 * one `savedAt` covered both.
 */
function readRecord() {
    const stored = readRaw();
    if (!stored || typeof stored !== 'object') return null;

    // Records written before the two timestamps were split carry one `savedAt`.
    const legacy = Number(stored.savedAt) || 0;
    return {
        tab: RESUMABLE_TABS.includes(`${stored.tab || ''}`) ? `${stored.tab}` : '',
        tabSavedAt: Number(stored.tabSavedAt) || legacy,
        wasUnlocked: stored.wasUnlocked === true,
        sessionAt: Number(stored.sessionAt) || legacy
    };
}

const fresh = (at) => Boolean(at) && Date.now() - at <= RESUME_HINT_MAX_AGE_MS;

/**
 * What this browser remembers, or null when there is nothing usable left.
 * @returns {ResumeHint|null}
 */
export function readResumeHint() {
    const record = readRecord();
    if (!record) return null;

    const tab = fresh(record.tabSavedAt) ? record.tab : '';
    const wasUnlocked = record.wasUnlocked && fresh(record.sessionAt);

    // Nothing worth acting on: drop the entry rather than leave it to be
    // re-read on every load.
    if (!tab && !wasUnlocked) {
        clearResumeHint();
        return null;
    }
    if (!tab) return { tab: '', wasUnlocked, savedAt: record.sessionAt };
    return { tab, wasUnlocked, savedAt: record.sessionAt || record.tabSavedAt };
}

/**
 * Remember the tab, and *only* the tab.
 *
 * Restoring a remembered tab drives the real tab button, which comes straight
 * back here — so this must not touch the session flag or its age, or simply
 * being put back where you were would renew the claim that your session was
 * interrupted.
 *
 * @param {string} tab
 */
export function rememberTab(tab) {
    if (!RESUMABLE_TABS.includes(`${tab}`)) return false;
    const record = readRecord();
    return write({
        tab: `${tab}`,
        tabSavedAt: Date.now(),
        wasUnlocked: record?.wasUnlocked === true,
        sessionAt: record?.sessionAt || 0
    });
}

/** A session is live in this page: whatever ends it, it ended mid-session. */
export function markSessionUnlocked() {
    const record = readRecord();
    const now = Date.now();
    return write({
        tab: record?.tab || 'publish',
        tabSavedAt: record?.tabSavedAt || now,
        wasUnlocked: true,
        sessionAt: now
    });
}

/**
 * The user locked up on purpose. The place is still worth remembering; being
 * told to unlock "again" is not, because nothing was interrupted.
 */
export function markSessionLocked() {
    const record = readRecord();
    if (!record) return false;
    return write({ tab: record.tab, tabSavedAt: record.tabSavedAt, wasUnlocked: false, sessionAt: 0 });
}

/**
 * Read the interrupted-session flag once and put it down.
 *
 * It answers "did the page take a live session with it", which is true of the
 * load that is happening now and of no later one. Leaving it set meant a
 * browser that never signed in again was told about the same interruption on
 * every visit for half a day. The remembered tab is untouched: where you were
 * is still true.
 *
 * @returns {boolean} whether a session had been interrupted
 */
export function consumeInterruptedSession() {
    const record = readRecord();
    if (!record?.wasUnlocked) return false;
    write({ tab: record.tab, tabSavedAt: record.tabSavedAt, wasUnlocked: false, sessionAt: 0 });
    return fresh(record.sessionAt);
}

export function clearResumeHint() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        return true;
    } catch (_) {
        return false;
    }
}
