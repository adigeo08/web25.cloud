// @ts-check
/**
 * Look up a NIP-01 kind-0 profile across the relay pool.
 *
 * This is what makes the Direct Messenger's address field feel like a search:
 * paste an `npub`, and the pool is asked whether any relay knows a display name
 * for it. It is a convenience only — the messaging flow never depends on a
 * profile being found, and a relay is never treated as an authority.
 *
 * Everything returned here is attacker-controlled text from a public relay, so
 * every field is type-checked, stripped of control characters and length-capped
 * before it leaves this module. The `picture` URL is deliberately *not*
 * returned: rendering a remote image would make the browser fetch an arbitrary
 * third-party host and leak the lookup, which is exactly what this app avoids
 * elsewhere.
 */

const PROFILE_KIND = 0;
const MAX_NAME_LENGTH = 64;
const MAX_ABOUT_LENGTH = 280;
const MAX_NIP05_LENGTH = 128;
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * C0/C1 controls plus the bidi overrides, which a hostile profile could
 * otherwise use to reorder what the UI displays.
 */
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function boundedText(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.replace(UNSAFE_TEXT_RE, ' ').trim().slice(0, maxLength);
}

/**
 * @param {any} event a locally verified kind-0 event
 * @returns {{ name: string, displayName: string, about: string, nip05: string }|null}
 */
export function parseNostrProfile(event) {
    if (!event || event.kind !== PROFILE_KIND || typeof event.content !== 'string') return null;
    let metadata;
    try {
        metadata = JSON.parse(event.content);
    } catch (_) {
        return null;
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;

    return {
        name: boundedText(metadata.name, MAX_NAME_LENGTH),
        displayName: boundedText(metadata.display_name ?? metadata.displayName, MAX_NAME_LENGTH),
        about: boundedText(metadata.about, MAX_ABOUT_LENGTH),
        nip05: boundedText(metadata.nip05, MAX_NIP05_LENGTH)
    };
}

/**
 * Ask every relay in the pool for the most recent kind-0 event by `publicKey`.
 *
 * Resolves with the newest profile seen before the timeout, or `null` if no
 * relay had one. Never rejects on relay trouble: a failed lookup just means the
 * address has no discoverable profile, which is not an error.
 *
 * @param {{ pool: any, publicKey: string, timeoutMs?: number }} params
 * @returns {Promise<{ name: string, displayName: string, about: string, nip05: string, createdAt: number }|null>}
 */
export function lookupNostrProfile({ pool, publicKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const author = `${publicKey || ''}`.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(author)) return Promise.resolve(null);

    return new Promise((resolve) => {
        /** @type {{ name: string, displayName: string, about: string, nip05: string, createdAt: number }|null} */
        let best = null;
        let subscription = null;
        let timer = null;

        const finish = () => {
            if (timer !== null) clearTimeout(timer);
            timer = null;
            try {
                subscription?.close();
            } catch (_) {
                // Already gone.
            }
            subscription = null;
            resolve(best);
        };

        try {
            subscription = pool.subscribe([{ kinds: [PROFILE_KIND], authors: [author], limit: 1 }], (event) => {
                const profile = parseNostrProfile(event);
                if (!profile) return;
                // Relays disagree; the newest event wins.
                if (best && best.createdAt >= event.created_at) return;
                best = { ...profile, createdAt: event.created_at };
            });
        } catch (_) {
            resolve(null);
            return;
        }

        timer = setTimeout(finish, timeoutMs);
    });
}
