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
    ECIES_SIGN: 'ECIES_SIGN',
    NOSTR_GET_PUBLIC_KEY: 'NOSTR_GET_PUBLIC_KEY',
    NOSTR_SIGN_EVENT: 'NOSTR_SIGN_EVENT',
    NOSTR_NIP44_ENCRYPT: 'NOSTR_NIP44_ENCRYPT',
    NOSTR_NIP44_DECRYPT: 'NOSTR_NIP44_DECRYPT'
});

/** Session TTL and inactivity timeout for an unlocked wallet. */
export const WALLET_SESSION_TTL_MS = 30 * 60 * 1000;

/** Operations that do not require an unlocked wallet. */
const UNAUTHENTICATED_OPS = /** @type {Set<string>} */ (new Set([WALLET_WORKER_OPS.LOCK, WALLET_WORKER_OPS.STATUS]));

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^[0-9a-fA-F]*$/;
const NOSTR_PUBKEY_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_MESSAGE_LENGTH = 128 * 1024;
const MAX_CIPHERTEXT_LENGTH = 4 * 1024 * 1024;

/** NIP-44 v2 caps the plaintext at 65535 bytes. */
const MAX_NIP44_PLAINTEXT_LENGTH = 65535;
/** Base64 of the largest legal NIP-44 payload, with headroom for padding. */
const MAX_NIP44_PAYLOAD_LENGTH = 90000;
/** Bounds on the event template the worker is willing to sign. */
const MAX_EVENT_CONTENT_LENGTH = MAX_NIP44_PAYLOAD_LENGTH;
const MAX_EVENT_TAGS = 64;
const MAX_EVENT_TAG_ITEMS = 32;
const MAX_EVENT_TAG_ITEM_LENGTH = 1024;
const MAX_EVENT_TIMESTAMP = 4102444800; // 2100-01-01, well past any real use

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
        case WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY:
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

        case WALLET_WORKER_OPS.NOSTR_SIGN_EVENT: {
            // Deliberately not a generic signer: only a well-formed Nostr event
            // template is accepted, and the worker computes the id itself so a
            // caller cannot get a signature over bytes of its own choosing.
            const kind = payload.kind;
            if (!Number.isInteger(kind) || kind < 0 || kind > 65535) {
                throw new WalletWorkerProtocolError('NOSTR_SIGN_EVENT requires an integer kind between 0 and 65535.');
            }

            const createdAt = payload.created_at;
            if (!Number.isInteger(createdAt) || createdAt < 0 || createdAt > MAX_EVENT_TIMESTAMP) {
                throw new WalletWorkerProtocolError('NOSTR_SIGN_EVENT requires a plausible integer created_at.');
            }

            const content = payload.content;
            if (typeof content !== 'string' || content.length > MAX_EVENT_CONTENT_LENGTH) {
                throw new WalletWorkerProtocolError('NOSTR_SIGN_EVENT content must be a string within the size limit.');
            }

            const tags = payload.tags === undefined ? [] : payload.tags;
            if (!Array.isArray(tags) || tags.length > MAX_EVENT_TAGS) {
                throw new WalletWorkerProtocolError('NOSTR_SIGN_EVENT tags must be an array within the size limit.');
            }
            const normalizedTags = [];
            for (const tag of tags) {
                if (!Array.isArray(tag) || tag.length === 0 || tag.length > MAX_EVENT_TAG_ITEMS) {
                    throw new WalletWorkerProtocolError('NOSTR_SIGN_EVENT tags must be non-empty string arrays.');
                }
                for (const item of tag) {
                    if (typeof item !== 'string' || item.length > MAX_EVENT_TAG_ITEM_LENGTH) {
                        throw new WalletWorkerProtocolError('NOSTR_SIGN_EVENT tag entries must be bounded strings.');
                    }
                }
                normalizedTags.push([...tag]);
            }

            return { kind, created_at: createdAt, tags: normalizedTags, content };
        }

        case WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT: {
            const plaintext = payload.plaintext;
            if (typeof plaintext !== 'string' || plaintext.length === 0 || plaintext.length > MAX_NIP44_PLAINTEXT_LENGTH) {
                throw new WalletWorkerProtocolError('NOSTR_NIP44_ENCRYPT requires a non-empty plaintext within the NIP-44 size limit.');
            }
            return { plaintext, peerPublicKey: requireNostrPublicKey(payload.peerPublicKey, type) };
        }

        case WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT: {
            const nip44Payload = payload.payload;
            if (typeof nip44Payload !== 'string' || nip44Payload.length === 0 || nip44Payload.length > MAX_NIP44_PAYLOAD_LENGTH) {
                throw new WalletWorkerProtocolError('NOSTR_NIP44_DECRYPT requires a base64 NIP-44 payload within the size limit.');
            }
            if (!BASE64_RE.test(nip44Payload)) {
                throw new WalletWorkerProtocolError('NOSTR_NIP44_DECRYPT payload is not valid base64.');
            }
            return { payload: nip44Payload, peerPublicKey: requireNostrPublicKey(payload.peerPublicKey, type) };
        }

        default:
            throw new WalletWorkerProtocolError(`Unsupported wallet worker operation: ${type}`);
    }
}

/**
 * @param {unknown} value
 * @param {string} type
 * @returns {string}
 */
function requireNostrPublicKey(value, type) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!NOSTR_PUBKEY_RE.test(normalized)) {
        throw new WalletWorkerProtocolError(`${type} requires a 32-byte hex Nostr public key.`);
    }
    return normalized;
}
