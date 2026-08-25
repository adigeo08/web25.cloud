// @ts-check
/**
 * Per-wallet "is this identity reachable over Nostr" preference.
 *
 * Important: the Nostr identity is not a separate key. It is the x coordinate
 * of the one wallet key, so it cannot be created or destroyed independently —
 * deriving it again from the same wallet always yields the same `npub`.
 *
 * What this flag controls is *reachability*: whether the app derives and
 * displays the Nostr address, subscribes the gift-wrapped inbox, and offers the
 * Nostr messaging flow. Removing it takes the identity off the relays and out
 * of the UI; it cannot make an already-published `npub` unknowable.
 *
 * Only a boolean is stored, keyed by EVM address. No key material of any kind
 * touches localStorage — that rule is unchanged.
 */

const STORAGE_PREFIX = 'web25.nostr.enabled.';

/** @param {string} address */
function storageKey(address) {
    return `${STORAGE_PREFIX}${`${address || ''}`.toLowerCase()}`;
}

/**
 * Reachability defaults to on, so a freshly created wallet is messageable
 * without a setup step.
 *
 * @param {string} address
 * @returns {boolean}
 */
export function isNostrIdentityEnabled(address) {
    if (!address) return false;
    try {
        return localStorage.getItem(storageKey(address)) !== 'off';
    } catch (_) {
        // Private mode or blocked storage: fall back to the default.
        return true;
    }
}

/**
 * @param {string} address
 * @param {boolean} enabled
 * @returns {boolean} the value now in effect
 */
export function setNostrIdentityEnabled(address, enabled) {
    if (!address) return false;
    try {
        localStorage.setItem(storageKey(address), enabled ? 'on' : 'off');
    } catch (_) {
        // Nothing to persist to; the in-memory auth state still carries it.
    }
    return enabled;
}

/**
 * Drop the preference entirely, e.g. when the wallet itself is deleted.
 * @param {string} address
 */
export function clearNostrIdentityPreference(address) {
    if (!address) return;
    try {
        localStorage.removeItem(storageKey(address));
    } catch (_) {
        // Nothing to clear.
    }
}
