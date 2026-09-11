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
 * The stored hint, or null when there is none, it is unreadable, it names a tab
 * this build does not have, or it is simply too old to mean anything.
 * @returns {ResumeHint|null}
 */
export function readResumeHint() {
    const stored = readRaw();
    if (!stored || typeof stored !== 'object') return null;

    const tab = `${stored.tab || ''}`;
    if (!RESUMABLE_TABS.includes(tab)) return null;

    const savedAt = Number(stored.savedAt) || 0;
    if (!savedAt || Date.now() - savedAt > RESUME_HINT_MAX_AGE_MS) {
        clearResumeHint();
        return null;
    }

    return { tab, wasUnlocked: stored.wasUnlocked === true, savedAt };
}

/**
 * Remember the tab, keeping whatever the session flag already said.
 * @param {string} tab
 */
export function rememberTab(tab) {
    if (!RESUMABLE_TABS.includes(`${tab}`)) return false;
    const existing = readResumeHint();
    return write({ tab: `${tab}`, wasUnlocked: existing?.wasUnlocked === true, savedAt: Date.now() });
}

/** A session is live in this page: whatever ends it, it ended mid-session. */
export function markSessionUnlocked() {
    const existing = readResumeHint();
    return write({ tab: existing?.tab || 'publish', wasUnlocked: true, savedAt: Date.now() });
}

/**
 * The user locked up on purpose. The place is still worth remembering; being
 * told to unlock "again" is not, because nothing was interrupted.
 */
export function markSessionLocked() {
    const existing = readResumeHint();
    if (!existing) return false;
    return write({ tab: existing.tab, wasUnlocked: false, savedAt: Date.now() });
}

export function clearResumeHint() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        return true;
    } catch (_) {
        return false;
    }
}
