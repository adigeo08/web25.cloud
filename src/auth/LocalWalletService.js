// @ts-check

import { loadViemAccounts } from '../web3/viemClients.js';
import { generateBip39Mnemonic, mnemonicToSeedBytes } from './SeedPhraseService.js';
import {
    decryptPrivateKey,
    deleteLocalWallet,
    encryptPrivateKey,
    getLocalWalletRecord,
    saveLocalWallet
} from './SecureKeyStore.js';

/** Auto-lock the private key after 15 minutes of inactivity. */
const AUTO_LOCK_TIMEOUT_MS = 15 * 60 * 1000;

/** @type {string | null} */
let unlockedPrivateKey = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let autoLockTimer = null;
let visibilityListenerAdded = false;

/** Clears the auto-lock timer and wipes the private key from memory. */
export function lockLocalWallet() {
    if (autoLockTimer !== null) {
        clearTimeout(autoLockTimer);
        autoLockTimer = null;
    }
    unlockedPrivateKey = null;
}

/** Resets the inactivity timer every time the key is used. */
function resetAutoLock() {
    if (autoLockTimer !== null) {
        clearTimeout(autoLockTimer);
    }
    autoLockTimer = setTimeout(lockLocalWallet, AUTO_LOCK_TIMEOUT_MS);
}

/** Sets up the auto-lock timer and the visibility-change listener (idempotent). */
function setupAutoLock() {
    if (!visibilityListenerAdded) {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                lockLocalWallet();
            }
        });
        visibilityListenerAdded = true;
    }
    resetAutoLock();
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
    const encrypted = await encryptPrivateKey(privateKey);

    await saveLocalWallet({
        address,
        encryptedPrivateKey: encrypted.encryptedPrivateKey,
        iv: encrypted.iv,
        createdAt: new Date().toISOString()
    });

    unlockedPrivateKey = privateKey;
    setupAutoLock();

    return { address, seedPhrase: mnemonic };
}

export async function unlockLocalWallet() {
    const record = await getLocalWalletRecord();
    if (!record) {
        throw new Error('No local wallet registered');
    }

    unlockedPrivateKey = await decryptPrivateKey(record.encryptedPrivateKey, record.iv);
    await saveLocalWallet({ ...record, lastUsedAt: new Date().toISOString() });
    setupAutoLock();
    return { address: record.address };
}

export async function getLocalWalletStatus() {
    const record = await getLocalWalletRecord();
    return {
        exists: Boolean(record),
        address: record?.address || null,
        unlocked: Boolean(unlockedPrivateKey)
    };
}

export async function signWithLocalWallet(message) {
    if (!unlockedPrivateKey) {
        throw new Error('Local wallet is locked');
    }
    resetAutoLock();
    const viemAccounts = await loadViemAccounts();
    const account = viemAccounts.privateKeyToAccount(unlockedPrivateKey);
    return account.signMessage({ message });
}

export async function removeLocalWallet() {
    lockLocalWallet();
    await deleteLocalWallet();
}
