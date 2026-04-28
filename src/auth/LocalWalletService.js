// @ts-check

import { loadViemAccounts } from '../web3/viemClients.js';
import { generateBip39Mnemonic, mnemonicToSeedBytes, validateBip39Mnemonic } from './SeedPhraseService.js';
import {
    createPasskeyLock,
    decryptPrivateKey,
    deleteLocalWallet,
    encryptPrivateKey,
    getLocalWalletRecord,
    passkeySupported,
    saveLocalWallet
} from './SecureKeyStore.js';

/** Auto-lock the private key after 15 minutes of inactivity. */
const AUTO_LOCK_TIMEOUT_MS = 15 * 60 * 1000;

/** @type {string | null} */
let unlockedPrivateKey = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let autoLockTimer = null;

// ---------------------------------------------------------------------------
// Service-worker session persistence
// The SW keeps the private key in its own (non-disk) memory so the session
// survives a page refresh within the AUTO_LOCK_TIMEOUT_MS window.
// ---------------------------------------------------------------------------

/** Milliseconds to wait for a SW query response before giving up. */
const SESSION_QUERY_TIMEOUT_MS = 3000;

/** Wait up to `maxWaitMs` for a SW controller to be available. */
function waitForSWController(maxWaitMs = 2000) {
    if (navigator.serviceWorker.controller) return Promise.resolve(true);
    return new Promise((resolve) => {
        const deadline = Date.now() + maxWaitMs;
        const tick = () => {
            if (navigator.serviceWorker.controller) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(tick, 100);
        };
        tick();
    });
}

/** Send the current private key to the SW so it survives a page refresh. */
async function storeSessionInSW() {
    if (!('serviceWorker' in navigator) || !unlockedPrivateKey) return;
    const ready = await waitForSWController();
    if (!ready || !navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage({
        type: 'SESSION_STORE',
        privateKey: unlockedPrivateKey,
        ttlMs: AUTO_LOCK_TIMEOUT_MS
    });
}

/** Extend the TTL of the SW session (called on every key use). */
function extendSessionInSW() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage({
        type: 'SESSION_EXTEND',
        ttlMs: AUTO_LOCK_TIMEOUT_MS
    });
}

/** Tell the SW to forget the session (called on explicit lock). */
function clearSessionInSW() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage({ type: 'SESSION_CLEAR' });
}

/**
 * On page load, asks the SW whether a valid session is still alive.
 * If so, restores `unlockedPrivateKey` so the user stays logged in.
 * @returns {Promise<boolean>} true if session was restored
 */
export async function restoreSessionFromSW() {
    if (!('serviceWorker' in navigator)) return false;

    const ready = await waitForSWController(SESSION_QUERY_TIMEOUT_MS);
    if (!ready || !navigator.serviceWorker.controller) return false;

    return new Promise((resolve) => {
        /** @type {ReturnType<typeof setTimeout>} */
        let timeoutId;
        const handler = (/** @type {MessageEvent} */ event) => {
            if (event.data?.type !== 'SESSION_RESPONSE') return;
            navigator.serviceWorker.removeEventListener('message', handler);
            clearTimeout(timeoutId);
            const key = event.data.privateKey;
            if (key) {
                unlockedPrivateKey = key;
                resetAutoLock();
                resolve(true);
            } else {
                resolve(false);
            }
        };
        navigator.serviceWorker.addEventListener('message', handler);
        timeoutId = setTimeout(() => {
            navigator.serviceWorker.removeEventListener('message', handler);
            resolve(false);
        }, SESSION_QUERY_TIMEOUT_MS);
        navigator.serviceWorker.controller.postMessage({ type: 'SESSION_QUERY' });
    });
}

// ---------------------------------------------------------------------------

/** Clears the auto-lock timer and wipes the private key from memory. */
export function lockLocalWallet() {
    void clearLocalWalletSession();
}

function clearInMemorySession() {
    if (autoLockTimer !== null) {
        clearTimeout(autoLockTimer);
        autoLockTimer = null;
    }
    unlockedPrivateKey = null;
}

export async function clearLocalWalletSession() {
    clearSessionInSW();
    clearInMemorySession();
}

/** Resets the inactivity timer every time the key is used. */
function resetAutoLock() {
    if (autoLockTimer !== null) {
        clearTimeout(autoLockTimer);
    }
    autoLockTimer = setTimeout(lockLocalWallet, AUTO_LOCK_TIMEOUT_MS);
}

/**
 * Derives the Ethereum private key (0x-prefixed hex string) from a BIP-39 mnemonic
 * using the standard derivation path m/44'/60'/0'/0/0.
 * @param {string} mnemonic
 * @returns {Promise<`0x${string}`>}
 */
async function derivePrivateKeyFromMnemonic(mnemonic) {
    const [{ HDKey }, seed] = await Promise.all([loadViemAccounts(), mnemonicToSeedBytes(mnemonic)]);
    const master = HDKey.fromMasterSeed(seed);
    const child = master.derive("m/44'/60'/0'/0/0");
    if (!child.privateKey) {
        throw new Error('Failed to derive private key from mnemonic');
    }
    const hex = Array.from(child.privateKey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return /** @type {`0x${string}`} */ (`0x${hex}`);
}

export async function registerLocalWallet() {
    const mnemonic = await generateBip39Mnemonic();
    const privateKey = await derivePrivateKeyFromMnemonic(mnemonic);
    const viemAccounts = await loadViemAccounts();
    const address = viemAccounts.privateKeyToAccount(privateKey).address;
    const lockKey = await createPasskeyLock(address);
    const { encryptedBlob } = await encryptPrivateKey(privateKey, lockKey.encPK);

    await saveLocalWallet({
        address,
        encryptedBlob,
        credentialId: lockKey.credentialId,
        encPKStored: lockKey.encPKStored,
        createdAt: new Date().toISOString(),
        passkeyProtected: passkeySupported()
    });

    unlockedPrivateKey = privateKey;
    resetAutoLock();
    void storeSessionInSW();

    return { address, seedPhrase: mnemonic };
}

export async function registerLocalWalletFromSeed(seedPhrase) {
    const existing = await getLocalWalletRecord();
    if (existing) {
        throw new Error('A local wallet already exists. Delete it first before recovering from a seed phrase.');
    }

    const normalized = seedPhrase.trim().toLowerCase().split(/\s+/).join(' ');

    const isValid = await validateBip39Mnemonic(normalized);
    if (!isValid) {
        throw new Error('Invalid seed phrase. Please verify all 12 words and order.');
    }

    const privateKey = await derivePrivateKeyFromMnemonic(normalized);
    const viemAccounts = await loadViemAccounts();
    const address = viemAccounts.privateKeyToAccount(privateKey).address;
    const lockKey = await createPasskeyLock(address);
    const { encryptedBlob } = await encryptPrivateKey(privateKey, lockKey.encPK);

    await saveLocalWallet({
        address,
        encryptedBlob,
        credentialId: lockKey.credentialId,
        encPKStored: lockKey.encPKStored,
        createdAt: new Date().toISOString(),
        passkeyProtected: passkeySupported()
    });

    unlockedPrivateKey = privateKey;
    resetAutoLock();
    void storeSessionInSW();
    return { address };
}

export async function unlockLocalWallet() {
    const record = await getLocalWalletRecord();
    if (!record) {
        throw new Error('No local wallet registered');
    }
    if (!record.encryptedBlob) {
        throw new Error('Legacy wallet format detected. Please migrate from seed phrase.');
    }

    unlockedPrivateKey = await decryptPrivateKey(record.encryptedBlob, record.credentialId);
    await saveLocalWallet({ ...record, lastUsedAt: new Date().toISOString() });
    resetAutoLock();
    void storeSessionInSW();
    return { address: record.address };
}

export async function getLocalWalletStatus() {
    const record = await getLocalWalletRecord();
    if (record && record.encryptedPrivateKey && !record.encryptedBlob) {
        return {
            exists: true,
            address: record.address,
            unlocked: false,
            needsMigration: true,
            passkeyProtected: false
        };
    }

    return {
        exists: Boolean(record),
        address: record?.address || null,
        unlocked: Boolean(unlockedPrivateKey),
        needsMigration: false,
        passkeyProtected: Boolean(record?.passkeyProtected ?? record?.credentialId)
    };
}

export async function signWithLocalWallet(message) {
    if (!unlockedPrivateKey) {
        throw new Error('Local wallet is locked');
    }
    resetAutoLock();
    extendSessionInSW();
    const viemAccounts = await loadViemAccounts();
    const account = viemAccounts.privateKeyToAccount(unlockedPrivateKey);
    return account.signMessage({ message });
}

export async function removeLocalWallet() {
    clearInMemorySession();
    await deleteLocalWallet();
}

/**
 * Returns the current in-memory unlocked private key, or null if locked.
 * @returns {string | null}
 */
export function getUnlockedPrivateKey() {
    return unlockedPrivateKey;
}
