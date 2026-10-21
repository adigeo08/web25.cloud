// @ts-check
/**
 * Whether a newly created wallet is still waiting for its recovery phrase to
 * be backed up.
 *
 * The phrase itself is never written anywhere: it lives in the backup screen
 * for as long as that screen is open and nowhere else. What survives a reload
 * is this one boolean, so a page that died before the user confirmed the
 * backup can say so honestly instead of treating the wallet as backed up — and
 * offer a reset, because the original words cannot be shown again.
 */

const STORAGE_KEY = 'web25.wallet.seedBackupPending.v1';

/** @returns {boolean} */
export function readSeedBackupPending() {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch (_) {
        return false;
    }
}

export function markSeedBackupPending() {
    try {
        localStorage.setItem(STORAGE_KEY, '1');
    } catch (_) {
        // Storage being unavailable only costs the reload notice.
    }
}

export function clearSeedBackupPending() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (_) {
        // Nothing to clear.
    }
}
