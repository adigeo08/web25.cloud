// @ts-check

import { loadViemAccounts } from '../web3/viemClients.js';
import { generateSeedPhrase } from './SeedPhraseService.js';
import {
    decryptPrivateKey,
    deleteLocalWallet,
    encryptPrivateKey,
    getLocalWalletRecord,
    saveLocalWallet
} from './SecureKeyStore.js';

let unlockedPrivateKey = null;

export async function registerLocalWallet() {
    const viemAccounts = await loadViemAccounts();
    const seedPhrase = generateSeedPhrase();
    const account = viemAccounts.generatePrivateKey();
    const address = viemAccounts.privateKeyToAccount(account).address;
    const encrypted = await encryptPrivateKey(account);

    await saveLocalWallet({
        address,
        encryptedPrivateKey: encrypted.encryptedPrivateKey,
        iv: encrypted.iv,
        createdAt: new Date().toISOString()
    });

    unlockedPrivateKey = account;

    return { address, seedPhrase };
}

export async function unlockLocalWallet() {
    const record = await getLocalWalletRecord();
    if (!record) {
        throw new Error('No local wallet registered');
    }

    unlockedPrivateKey = await decryptPrivateKey(record.encryptedPrivateKey, record.iv);
    await saveLocalWallet({ ...record, lastUsedAt: new Date().toISOString() });
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
    const viemAccounts = await loadViemAccounts();
    const account = viemAccounts.privateKeyToAccount(unlockedPrivateKey);
    return account.signMessage({ message });
}

export function lockLocalWallet() {
    unlockedPrivateKey = null;
}

export async function removeLocalWallet() {
    unlockedPrivateKey = null;
    await deleteLocalWallet();
}
