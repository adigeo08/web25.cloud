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
    const { encryptedBlob } = await encryptPrivateKey(privateKey, lockKey);

    await saveLocalWallet({
        address,
        encryptedBlob,
        localIdentityID: lockKey.localIdentity,
        createdAt: new Date().toISOString(),
        passkeyProtected: passkeySupported()
    });

    unlockedPrivateKey = privateKey;
    resetAutoLock();

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
    const { encryptedBlob } = await encryptPrivateKey(privateKey, lockKey);

    await saveLocalWallet({
        address,
        encryptedBlob,
        localIdentityID: lockKey.localIdentity,
        createdAt: new Date().toISOString(),
        passkeyProtected: passkeySupported()
    });

    unlockedPrivateKey = privateKey;
    resetAutoLock();
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

    unlockedPrivateKey = await decryptPrivateKey(record.encryptedBlob, record.localIdentityID);
    await saveLocalWallet({ ...record, lastUsedAt: new Date().toISOString() });
    resetAutoLock();
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
        passkeyProtected: Boolean(record?.passkeyProtected ?? record?.localIdentityID)
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
