// @ts-check
/**
 * Local wallet façade.
 *
 * The decrypted EVM private key lives in the dedicated wallet worker and
 * nowhere else. It touches the main thread for exactly two moments — right
 * after it is derived from a mnemonic and right after the passkey vault is
 * opened — and the local binding is cleared before either function returns.
 *
 * There is intentionally no exported accessor for the key. Callers ask for
 * signatures and decryptions instead.
 */

import { loadViemAccounts } from '../web3/viemClients.js';
import { generateBip39Mnemonic, mnemonicToSeedBytes, validateBip39Mnemonic } from './SeedPhraseService.js';
import {
    createProtectedWallet,
    decryptPrivateKey,
    deleteLocalWallet,
    getLocalWalletRecord,
    passkeySupported,
    saveLocalWallet,
    walletRecordNeedsMigration,
    WALLET_VAULT_VERSION
} from './SecureKeyStore.js';
import {
    lockWalletWorker,
    onWalletLocked,
    terminateWalletWorker,
    unlockWalletWorker,
    walletWorkerStatus,
    workerEciesDecrypt,
    workerEciesSign,
    workerGetPublicKey,
    workerSignMessage
} from './WalletWorkerClient.js';
import { WALLET_SESSION_TTL_MS } from './walletWorkerProtocol.js';

/** Session TTL / inactivity timeout enforced inside the worker. */
export const AUTO_LOCK_TIMEOUT_MS = WALLET_SESSION_TTL_MS;

/**
 * Hand the key over and drop the main-thread reference.
 * @param {{ value: string | null }} holder single-field box so the caller's
 *        binding can be cleared from here, before this function returns.
 */
async function transferKeyToWorker(holder) {
    const privateKey = holder.value;
    if (!privateKey) throw new Error('No private key to transfer.');
    try {
        return await unlockWalletWorker(privateKey);
    } finally {
        holder.value = null;
    }
}

/** Subscribe to worker-side lock events (TTL expiry, worker crash). */
export { onWalletLocked };

/** Clears the worker session; the key is wiped inside the worker immediately. */
export function lockLocalWallet() {
    void clearLocalWalletSession();
}

export async function clearLocalWalletSession() {
    await lockWalletWorker();
}

/**
 * Hard reset: terminate the worker entirely. A restarted worker starts locked.
 */
export function destroyLocalWalletSession() {
    terminateWalletWorker();
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

/**
 * Derive, seal and hand off a freshly created wallet.
 * @param {string} mnemonic
 * @returns {Promise<{ address: string }>}
 */
async function provisionWallet(mnemonic) {
    const holder = { value: /** @type {string | null} */ (await derivePrivateKeyFromMnemonic(mnemonic)) };
    try {
        const viemAccounts = await loadViemAccounts();
        const address = viemAccounts.privateKeyToAccount(/** @type {any} */ (holder.value)).address;
        const vault = await createProtectedWallet(address, /** @type {string} */ (holder.value));

        await saveLocalWallet({
            address,
            encryptedBlob: vault.encryptedBlob,
            credentialId: vault.credentialId,
            vaultId: vault.vaultId,
            vaultVersion: WALLET_VAULT_VERSION,
            createdAt: new Date().toISOString(),
            passkeyProtected: passkeySupported()
        });

        await transferKeyToWorker(holder);
        return { address };
    } finally {
        holder.value = null;
    }
}

export async function registerLocalWallet() {
    const mnemonic = await generateBip39Mnemonic();
    const { address } = await provisionWallet(mnemonic);
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

    return provisionWallet(normalized);
}

export async function unlockLocalWallet() {
    const record = await getLocalWalletRecord();
    if (!record) {
        throw new Error('No local wallet registered');
    }
    if (walletRecordNeedsMigration(record)) {
        throw new Error(
            'This wallet uses the previous passkey format, which is no longer supported. Please recover it from your seed phrase.'
        );
    }

    const holder = { value: /** @type {string | null} */ (null) };
    try {
        holder.value = await decryptPrivateKey(record.encryptedBlob, record.credentialId);
        await transferKeyToWorker(holder);
    } finally {
        holder.value = null;
    }

    await saveLocalWallet({ ...record, lastUsedAt: new Date().toISOString() });
    return { address: record.address };
}

export async function getLocalWalletStatus() {
    const record = await getLocalWalletRecord();
    const session = await walletWorkerStatus();

    if (record && walletRecordNeedsMigration(record)) {
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
        unlocked: Boolean(session.unlocked),
        needsMigration: false,
        passkeyProtected: Boolean(record?.passkeyProtected ?? record?.credentialId)
    };
}

/**
 * EIP-191 signature produced inside the worker.
 * @param {string} message
 * @returns {Promise<`0x${string}`>}
 */
export async function signWithLocalWallet(message) {
    return workerSignMessage(message);
}

/**
 * secp256k1/SHA-256 compact signature used by the Direct Messenger transport.
 * @param {string} message
 */
export async function eciesSignWithLocalWallet(message) {
    return workerEciesSign(message);
}

/**
 * ECIES decryption performed inside the worker.
 * @param {string} ciphertext hex payload
 */
export async function eciesDecryptWithLocalWallet(ciphertext) {
    return workerEciesDecrypt(ciphertext);
}

/**
 * The wallet's uncompressed secp256k1 public key. Public material only — this
 * is not, and cannot be turned into, the private key.
 * @returns {Promise<string | null>}
 */
export async function getLocalWalletPublicKey() {
    try {
        const { publicKey } = await workerGetPublicKey();
        return publicKey;
    } catch (_) {
        return null;
    }
}

/** @returns {Promise<boolean>} */
export async function isLocalWalletUnlocked() {
    const status = await walletWorkerStatus();
    return Boolean(status.unlocked);
}

/**
 * Signing/decryption handle handed to services that must not see the key.
 * @returns {{ getPublicKey: () => Promise<string|null>, signMessage: (m: string) => Promise<string>, eciesDecrypt: (c: string) => Promise<string> }}
 */
export function createLocalWalletSigner() {
    return {
        getPublicKey: getLocalWalletPublicKey,
        signMessage: eciesSignWithLocalWallet,
        eciesDecrypt: eciesDecryptWithLocalWallet
    };
}

export async function removeLocalWallet() {
    await clearLocalWalletSession();
    await deleteLocalWallet();
}
