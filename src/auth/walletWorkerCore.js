// @ts-check
/**
 * Session logic for the dedicated wallet worker, isolated from the worker
 * globals so it can be exercised directly by tests.
 *
 * The private key lives in this closure only. Every exposed operation is one of
 * the fixed types in `walletWorkerProtocol.js`; none of them returns the key,
 * and there is no generic "execute" command.
 */

import { validateWalletRequest, WALLET_WORKER_OPS, WALLET_SESSION_TTL_MS } from './walletWorkerProtocol.js';
import { npubEncode } from '../nostr/nip19.js';

/**
 * @param {{
 *   ecies: {
 *     getPublicKeyFromPrivateKey: (key: string) => string,
 *     evmAddressFromPublicKey: (key: string) => string,
 *     signEvmMessage: (message: string, key: string) => string,
 *     signMessage: (message: string, key: string) => Promise<string>,
 *     eciesDecrypt: (ciphertext: string, key: string) => Promise<string>
 *   },
 *   nostr?: {
 *     getNostrPublicKey: (key: string) => string,
 *     signEvent: (template: object, key: string) => object,
 *     nip44ConversationKey: (key: string, peerPublicKey: string) => Uint8Array,
 *     nip44Encrypt: (plaintext: string, conversationKey: Uint8Array) => string,
 *     nip44Decrypt: (payload: string, conversationKey: Uint8Array) => string
 *   } | null,
 *   ttlMs?: number,
 *   now?: () => number,
 *   onLock?: (reason: string) => void
 * }} deps
 */
export function createWalletWorkerCore({ ecies, nostr = null, ttlMs = WALLET_SESSION_TTL_MS, now = Date.now, onLock = null }) {
    /** @type {{ privateKey: string, publicKey: string, address: string, nostrPublicKey: string, npub: string, expiresAt: number } | null} */
    let session = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let expiryTimer = null;

    function clearSession() {
        if (expiryTimer !== null) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
        }
        session = null;
    }

    function scheduleExpiry(delayMs) {
        if (expiryTimer !== null) clearTimeout(expiryTimer);
        expiryTimer = setTimeout(() => {
            clearSession();
            if (onLock) onLock('session-expired');
        }, delayMs);
        // Never keep a Node test process alive on account of the TTL timer.
        if (expiryTimer && typeof (/** @type {any} */ (expiryTimer).unref) === 'function') {
            /** @type {any} */ (expiryTimer).unref();
        }
    }

    /** Inactivity timeout: every successful key use pushes the deadline out. */
    function touchSession() {
        if (!session) return;
        session.expiresAt = now() + ttlMs;
        scheduleExpiry(ttlMs);
    }

    function requireSession() {
        if (!session) {
            throw new Error('Wallet is locked.');
        }
        if (session.expiresAt <= now()) {
            clearSession();
            throw new Error('Wallet session expired. Unlock again with your passkey.');
        }
        return session;
    }

    function requireNostr() {
        if (!nostr) throw new Error('Nostr support is unavailable in this wallet worker build.');
        return nostr;
    }

    /** Every Nostr private-key operation goes through the same lock check. */
    function requireNostrSession() {
        requireNostr();
        const active = requireSession();
        if (!active.nostrPublicKey) throw new Error('Nostr identity is unavailable for this session.');
        return active;
    }

    function statusPayload() {
        const alive = Boolean(session && session.expiresAt > now());
        if (session && !alive) clearSession();
        return {
            unlocked: alive,
            address: alive && session ? session.address : null,
            expiresAt: alive && session ? session.expiresAt : null
        };
    }

    /**
     * @param {string} type
     * @param {Record<string, any>} payload
     */
    async function execute(type, payload) {
        switch (type) {
            case WALLET_WORKER_OPS.UNLOCK: {
                // Re-unlocking replaces any previous session outright.
                clearSession();
                const publicKey = ecies.getPublicKeyFromPrivateKey(payload.privateKey);
                const address = ecies.evmAddressFromPublicKey(publicKey);
                // One key, three identities. The Nostr public key is the x
                // coordinate of the very same secp256k1 point — there is no
                // second seed and no second private key anywhere.
                const nostrPublicKey = nostr ? nostr.getNostrPublicKey(payload.privateKey) : '';
                session = {
                    privateKey: payload.privateKey,
                    publicKey,
                    address,
                    nostrPublicKey,
                    npub: nostrPublicKey ? npubEncode(nostrPublicKey) : '',
                    expiresAt: now() + payload.ttlMs
                };
                scheduleExpiry(payload.ttlMs);
                return { unlocked: true, address, publicKey, expiresAt: session.expiresAt };
            }

            case WALLET_WORKER_OPS.LOCK:
                clearSession();
                return { unlocked: false };

            case WALLET_WORKER_OPS.STATUS:
                return statusPayload();

            case WALLET_WORKER_OPS.GET_PUBLIC_KEY: {
                const active = requireSession();
                touchSession();
                return { publicKey: active.publicKey, address: active.address };
            }

            case WALLET_WORKER_OPS.SIGN_MESSAGE: {
                const active = requireSession();
                const signature = ecies.signEvmMessage(payload.message, active.privateKey);
                touchSession();
                return { signature };
            }

            case WALLET_WORKER_OPS.ECIES_SIGN: {
                const active = requireSession();
                const signature = await ecies.signMessage(payload.message, active.privateKey);
                touchSession();
                return { signature };
            }

            case WALLET_WORKER_OPS.ECIES_DECRYPT: {
                const active = requireSession();
                const plaintext = await ecies.eciesDecrypt(payload.ciphertext, active.privateKey);
                touchSession();
                return { plaintext };
            }

            case WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY: {
                const active = requireNostrSession();
                touchSession();
                // Public material only: the x-only public key and its NIP-19
                // form. There is no operation that returns an `nsec`.
                return { nostrPublicKey: active.nostrPublicKey, npub: active.npub };
            }

            case WALLET_WORKER_OPS.NOSTR_SIGN_EVENT: {
                const active = requireNostrSession();
                const event = requireNostr().signEvent(
                    {
                        kind: payload.kind,
                        created_at: payload.created_at,
                        tags: payload.tags,
                        content: payload.content
                    },
                    active.privateKey
                );
                touchSession();
                return { event };
            }

            case WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT: {
                const active = requireNostrSession();
                const nostrApi = requireNostr();
                const conversationKey = nostrApi.nip44ConversationKey(active.privateKey, payload.peerPublicKey);
                const result = nostrApi.nip44Encrypt(payload.plaintext, conversationKey);
                touchSession();
                return { payload: result };
            }

            case WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT: {
                const active = requireNostrSession();
                const nostrApi = requireNostr();
                const conversationKey = nostrApi.nip44ConversationKey(active.privateKey, payload.peerPublicKey);
                const plaintext = nostrApi.nip44Decrypt(payload.payload, conversationKey);
                touchSession();
                return { plaintext };
            }

            default:
                // Unreachable: validateWalletRequest rejects unknown types first.
                throw new Error(`Unsupported wallet worker operation: ${type}`);
        }
    }

    /**
     * Validate and run one request envelope, returning the response envelope.
     * @param {unknown} raw
     * @returns {Promise<{ type: 'RESPONSE', id: string | null, ok: boolean, result?: any, error?: string }>}
     */
    async function handle(raw) {
        let request;
        try {
            request = validateWalletRequest(raw);
        } catch (error) {
            const id = typeof (/** @type {any} */ (raw)?.id) === 'string' ? /** @type {any} */ (raw).id : null;
            return {
                type: 'RESPONSE',
                id,
                ok: false,
                error: error instanceof Error ? error.message : 'Invalid wallet worker request.'
            };
        }

        try {
            const result = await execute(request.type, request.payload);
            return { type: 'RESPONSE', id: request.id, ok: true, result };
        } catch (error) {
            return {
                type: 'RESPONSE',
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    return { handle, dispose: clearSession };
}
