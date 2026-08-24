// @ts-check
/**
 * Wire protocol shared by the main thread and the dedicated wallet worker.
 *
 * The worker exposes a fixed, closed set of operations. There is deliberately
 * no "run this operation" / "eval" style command: every request is matched
 * against `WALLET_WORKER_OPS` and its payload is validated field by field
 * before any key material is touched.
 */

export const WALLET_WORKER_OPS = /** @type {const} */ ({
    UNLOCK: 'UNLOCK',
    LOCK: 'LOCK',
    STATUS: 'STATUS',
    SIGN_MESSAGE: 'SIGN_MESSAGE',
    GET_PUBLIC_KEY: 'GET_PUBLIC_KEY',
    ECIES_DECRYPT: 'ECIES_DECRYPT',
    ECIES_SIGN: 'ECIES_SIGN'
});

/** Session TTL and inactivity timeout for an unlocked wallet. */
export const WALLET_SESSION_TTL_MS = 30 * 60 * 1000;

/** Operations that do not require an unlocked wallet. */
const UNAUTHENTICATED_OPS = /** @type {Set<string>} */ (new Set([WALLET_WORKER_OPS.LOCK, WALLET_WORKER_OPS.STATUS]));

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^[0-9a-fA-F]*$/;
const MAX_MESSAGE_LENGTH = 128 * 1024;
const MAX_CIPHERTEXT_LENGTH = 4 * 1024 * 1024;

export class WalletWorkerProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WalletWorkerProtocolError';
    }
}

/**
 * Validate an inbound request envelope and its payload.
 * Throws `WalletWorkerProtocolError` for anything that is not an exact match.
 *
 * @param {unknown} raw
 * @returns {{ id: string, type: string, payload: Record<string, any>, requiresUnlock: boolean }}
 */
export function validateWalletRequest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new WalletWorkerProtocolError('Malformed wallet worker request.');
    }

    const envelope = /** @type {Record<string, any>} */ (raw);
    const id = envelope.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
        throw new WalletWorkerProtocolError('Wallet worker request is missing a valid id.');
    }

    const type = envelope.type;
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(WALLET_WORKER_OPS, type)) {
        throw new WalletWorkerProtocolError(`Unsupported wallet worker operation: ${String(type)}`);
    }

    const payload = envelope.payload === undefined ? {} : envelope.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new WalletWorkerProtocolError('Wallet worker payload must be a plain object.');
    }

    const validated = validatePayload(type, /** @type {Record<string, any>} */ (payload));

    return {
        id,
        type,
        payload: validated,
        requiresUnlock: !UNAUTHENTICATED_OPS.has(type)
    };
}

/**
 * @param {string} type
 * @param {Record<string, any>} payload
 * @returns {Record<string, any>}
 */
function validatePayload(type, payload) {
    switch (type) {
        case WALLET_WORKER_OPS.UNLOCK: {
            const privateKey = payload.privateKey;
            if (typeof privateKey !== 'string' || !PRIVATE_KEY_RE.test(privateKey)) {
                throw new WalletWorkerProtocolError('UNLOCK requires a 0x-prefixed 32-byte private key.');
            }
            const ttlMs = payload.ttlMs === undefined ? WALLET_SESSION_TTL_MS : payload.ttlMs;
            if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > WALLET_SESSION_TTL_MS) {
                throw new WalletWorkerProtocolError(
                    'UNLOCK ttlMs must be a positive number no larger than the session TTL.'
                );
            }
            return { privateKey, ttlMs };
        }

        case WALLET_WORKER_OPS.LOCK:
        case WALLET_WORKER_OPS.STATUS:
        case WALLET_WORKER_OPS.GET_PUBLIC_KEY:
            return {};

        case WALLET_WORKER_OPS.SIGN_MESSAGE:
        case WALLET_WORKER_OPS.ECIES_SIGN: {
            const message = payload.message;
            if (typeof message !== 'string') {
                throw new WalletWorkerProtocolError(`${type} requires a string message.`);
            }
            if (message.length > MAX_MESSAGE_LENGTH) {
                throw new WalletWorkerProtocolError(`${type} message exceeds the maximum allowed length.`);
            }
            return { message };
        }

        case WALLET_WORKER_OPS.ECIES_DECRYPT: {
            const ciphertext = payload.ciphertext;
            if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
                throw new WalletWorkerProtocolError('ECIES_DECRYPT requires a hex ciphertext string.');
            }
            if (ciphertext.length > MAX_CIPHERTEXT_LENGTH) {
                throw new WalletWorkerProtocolError('ECIES_DECRYPT ciphertext exceeds the maximum allowed length.');
            }
            // 65-byte ephemeral key + 12-byte IV + at least the GCM tag.
            if (ciphertext.length < (65 + 12 + 16) * 2 || ciphertext.length % 2 !== 0 || !HEX_RE.test(ciphertext)) {
                throw new WalletWorkerProtocolError('ECIES_DECRYPT ciphertext is not a well-formed ECIES payload.');
            }
            return { ciphertext };
        }

        default:
            throw new WalletWorkerProtocolError(`Unsupported wallet worker operation: ${type}`);
    }
}
