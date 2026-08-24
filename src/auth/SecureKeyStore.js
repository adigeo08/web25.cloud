// @ts-check

import {
    addPasskeyToVault,
    createPasskeyVault,
    deletePasskeyVault,
    hasLegacyCredentialRecord,
    isLegacyVaultBlob,
    LegacyVaultError,
    openPasskeyVault,
    passkeySupported,
    readCredentialRecord
} from './PasskeyVault.js';

/** Wallet records written by this version carry the PRF vault layout. */
export const WALLET_VAULT_VERSION = 2;

const DB_NAME = 'web25-auth';
const DB_VERSION = 2;
const STORE_WALLETS = 'wallets';
const STORE_KEYS = 'keys';
const LOCAL_WALLET_ID = 'default-local-wallet';

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_WALLETS)) {
                db.createObjectStore(STORE_WALLETS, { keyPath: 'walletId' });
            }
            if (db.objectStoreNames.contains(STORE_KEYS)) {
                db.deleteObjectStore(STORE_KEYS);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function readRecord(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

function writeRecord(db, storeName, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).put(value);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

function deleteRecord(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

export async function getLocalWalletRecord() {
    const db = await openDb();
    return readRecord(db, STORE_WALLETS, LOCAL_WALLET_ID);
}

/**
 * Create the passkey-protected vault for a brand new wallet and seal the
 * private key into it in one WebAuthn ceremony.
 *
 * @param {string} address
 * @param {string} privateKeyHex
 * @returns {Promise<{ credentialId: string, vaultId: string, encryptedBlob: string }>}
 */
export async function createProtectedWallet(address, privateKeyHex) {
    const vault = await createPasskeyVault({
        username: address.slice(0, 10),
        displayName: `web25 wallet ${address.slice(0, 6)}`,
        secret: privateKeyHex
    });
    return {
        credentialId: vault.credentialId,
        vaultId: vault.vaultId,
        encryptedBlob: vault.sealedBlob
    };
}

/**
 * Decrypt the wallet blob via a WebAuthn PRF assertion.
 * @param {string} encryptedBlob
 * @param {string} credentialId
 * @returns {Promise<string>} the 0x-prefixed private key
 */
export async function decryptPrivateKey(encryptedBlob, credentialId) {
    return openPasskeyVault(credentialId, encryptedBlob);
}

/**
 * A wallet record needs seed-phrase recovery when it predates the PRF vault.
 * @param {any} record
 */
export function walletRecordNeedsMigration(record) {
    if (!record) return false;
    if (record.encryptedPrivateKey && !record.encryptedBlob) return true;
    if (!record.encryptedBlob) return true;
    if (record.vaultVersion !== WALLET_VAULT_VERSION) return true;
    if (isLegacyVaultBlob(record.encryptedBlob)) return true;
    if (record.credentialId && !readCredentialRecord(record.credentialId)) return true;
    return false;
}

export async function saveLocalWallet(record) {
    const db = await openDb();
    await writeRecord(db, STORE_WALLETS, {
        ...record,
        walletId: LOCAL_WALLET_ID,
        lastUsedAt: new Date().toISOString()
    });
}

export async function addAlternatePasskey(credentialId) {
    return addPasskeyToVault(credentialId);
}

export { hasLegacyCredentialRecord, isLegacyVaultBlob, LegacyVaultError, passkeySupported };

export async function deleteLocalWallet() {
    const db = await openDb();
    const record = await readRecord(db, STORE_WALLETS, LOCAL_WALLET_ID);
    await deleteRecord(db, STORE_WALLETS, LOCAL_WALLET_ID);

    if (record?.credentialId) {
        await deletePasskeyVault(record.credentialId);
    }
}
