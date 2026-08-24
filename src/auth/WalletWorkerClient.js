// @ts-check
/**
 * Main-thread client for the dedicated wallet worker.
 *
 * This module is the *only* way the application talks to the unlocked key, and
 * it deliberately offers no accessor that returns it. Callers can ask for a
 * signature, a decryption or the public key — nothing else.
 */

import { WALLET_WORKER_OPS, WALLET_SESSION_TTL_MS } from './walletWorkerProtocol.js';

const REQUEST_TIMEOUT_MS = 20000;

/** @type {Worker | null} */
let worker = null;
/** @type {Map<string, { resolve: (value: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
const pending = new Map();
/** @type {Set<(reason: string) => void>} */
const lockListeners = new Set();
let requestCounter = 0;

function rejectAllPending(reason) {
    for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
    }
    pending.clear();
}

function handleWorkerMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'EVENT') {
        if (data.event === 'LOCKED') {
            lockListeners.forEach((listener) => listener(`${data.reason || 'locked'}`));
        }
        return;
    }

    if (data.type !== 'RESPONSE' || typeof data.id !== 'string') return;

    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);

    if (data.ok) {
        entry.resolve(data.result);
    } else {
        entry.reject(new Error(`${data.error || 'Wallet worker operation failed.'}`));
    }
}

function ensureWorker() {
    if (worker) return worker;
    if (typeof Worker !== 'function') {
        throw new Error('Dedicated Workers are not available in this browser; the wallet cannot be unlocked safely.');
    }

    worker = new Worker(new URL('./wallet-worker.js', import.meta.url), {
        type: 'module',
        name: 'web25-wallet'
    });
    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', () => {
        // A crashed worker means the key is gone — treat it as a hard lock.
        rejectAllPending('Wallet worker crashed; the wallet is locked.');
        lockListeners.forEach((listener) => listener('worker-error'));
        worker?.terminate();
        worker = null;
    });

    return worker;
}

/**
 * @param {string} type
 * @param {Record<string, any>} [payload]
 * @returns {Promise<any>}
 */
function request(type, payload = {}) {
    let active;
    try {
        active = ensureWorker();
    } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    requestCounter += 1;
    const id = `w${requestCounter}-${Math.random().toString(36).slice(2, 10)}`;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Wallet worker timed out handling ${type}.`));
        }, REQUEST_TIMEOUT_MS);

        pending.set(id, { resolve, reject, timer });
        active.postMessage({ id, type, payload });
    });
}

/**
 * Subscribe to worker-side lock events (TTL expiry, crash).
 * @param {(reason: string) => void} listener
 */
export function onWalletLocked(listener) {
    lockListeners.add(listener);
    return () => lockListeners.delete(listener);
}

/**
 * Hand the private key to the worker. The caller must drop its own reference
 * immediately after this resolves.
 * @param {string} privateKey 0x-prefixed hex
 * @returns {Promise<{ unlocked: boolean, address: string, publicKey: string, expiresAt: number }>}
 */
export function unlockWalletWorker(privateKey) {
    return request(WALLET_WORKER_OPS.UNLOCK, { privateKey, ttlMs: WALLET_SESSION_TTL_MS });
}

/** Wipe the key from the worker immediately. */
export async function lockWalletWorker() {
    if (!worker) return;
    try {
        await request(WALLET_WORKER_OPS.LOCK);
    } catch (_) {
        // A worker that cannot answer is already unusable; terminate below.
    }
}

/**
 * Terminate the worker outright. Any key it held dies with it.
 */
export function terminateWalletWorker() {
    if (!worker) return;
    worker.terminate();
    worker = null;
    rejectAllPending('Wallet worker terminated.');
}

/** @returns {Promise<{ unlocked: boolean, address: string | null, expiresAt: number | null }>} */
export async function walletWorkerStatus() {
    if (!worker) return { unlocked: false, address: null, expiresAt: null };
    try {
        return await request(WALLET_WORKER_OPS.STATUS);
    } catch (_) {
        return { unlocked: false, address: null, expiresAt: null };
    }
}

/**
 * EIP-191 `personal_sign` over `message`.
 * @param {string} message
 * @returns {Promise<`0x${string}`>}
 */
export async function workerSignMessage(message) {
    const result = await request(WALLET_WORKER_OPS.SIGN_MESSAGE, { message });
    return result.signature;
}

/**
 * secp256k1 / SHA-256 compact signature used by the Direct Messenger.
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function workerEciesSign(message) {
    const result = await request(WALLET_WORKER_OPS.ECIES_SIGN, { message });
    return result.signature;
}

/**
 * @param {string} ciphertext hex ECIES payload
 * @returns {Promise<string>}
 */
export async function workerEciesDecrypt(ciphertext) {
    const result = await request(WALLET_WORKER_OPS.ECIES_DECRYPT, { ciphertext });
    return result.plaintext;
}

/**
 * @returns {Promise<{ publicKey: string, address: string }>}
 */
export function workerGetPublicKey() {
    return request(WALLET_WORKER_OPS.GET_PUBLIC_KEY);
}
