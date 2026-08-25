// @ts-check
/**
 * Transport-neutral Direct Messenger bootstrap logic.
 *
 * The same invitation envelope — TTL, session id, reply-id, nonce, replay
 * protection and identity binding — is used no matter how it travels:
 *
 *   WebTorrent : `DirectMessageTorrentBootstrap.js` seeds the envelope inside
 *                a signed `.torrentchain` artifact and binds the sender to the
 *                verified TorrentChain publisher.
 *   Nostr      : `NostrDirectMessageBootstrap.js` puts the envelope inside a
 *                NIP-59 gift wrap and binds the sender to the key that signed
 *                the NIP-59 seal.
 *
 * Two envelope shapes exist, because the two addressing models carry different
 * amounts of key material:
 *
 *   `direct-message-bootstrap-v2` (ECIES)
 *       Used whenever the sender knows the recipient's *uncompressed* ECIES
 *       public key. The inner payload is ECIES-encrypted for that key, exactly
 *       as before.
 *
 *   `direct-message-bootstrap-sealed-v1` (Nostr-addressed)
 *       Used when the recipient is known only by `npub`. A Nostr address is
 *       the x coordinate of the key, which is not enough to run ECIES against,
 *       so confidentiality for this one hop comes from the NIP-44/NIP-59 layer
 *       the envelope travels inside. Authenticity is unchanged: the payload
 *       still carries a Web25 secp256k1 signature from the sender's wallet, and
 *       every later message runs through the full ECIES path once both sides
 *       have exchanged their full public keys.
 */

import { eciesEncrypt, evmAddressFromPublicKey } from './ecies.js';

export const BOOTSTRAP_FILE_NAME = 'dm-bootstrap.json';
export const BOOTSTRAP_TYPE = 'direct-message-bootstrap-v2';
export const BOOTSTRAP_VERSION = 2;
export const SEALED_BOOTSTRAP_TYPE = 'direct-message-bootstrap-sealed-v1';
export const SEALED_BOOTSTRAP_VERSION = 1;
export const ECIES_ALGORITHM = 'ECIES-secp256k1-HKDF-SHA256-AES-256-GCM';
export const SEALED_ALGORITHM = 'NIP-44-v2+NIP-59';
export const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

const HEX32_RE = /^[0-9a-f]{64}$/;

/** Session ids already consumed on this page load. */
const replayCache = new Set();

/** @internal test-only helper so suites do not leak replay state into each other. */
export function _resetBootstrapReplayCache() {
    replayCache.clear();
}

export function randomHex(bytes = 8) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Validate a recipient ECIES public key and derive its EVM address.
 * @param {string} publicKeyHex
 * @returns {{ publicKey: string, evmAddress: string }}
 */
export function validateRecipientPublicKey(publicKeyHex) {
    const normalized = `${publicKeyHex || ''}`.trim().replace(/^0x/, '');
    if (!normalized) throw new Error('Recipient ECIES public key is required.');
    if (!/^04[0-9a-f]{128}$/i.test(normalized)) {
        throw new Error('Recipient ECIES public key must be an uncompressed secp256k1 key (04… hex, 130 hex chars).');
    }
    let evmAddress;
    try {
        evmAddress = evmAddressFromPublicKey(normalized);
    } catch (_) {
        throw new Error('Recipient ECIES public key is not a valid secp256k1 public key.');
    }
    return { publicKey: normalized, evmAddress };
}

/**
 * Build the sensitive inner payload shared by every transport.
 *
 * @param {{ identity: { address: string }, eciesPublicKey: string, role: string,
 *           webrtcDescription: RTCSessionDescriptionInit, sessionId?: string|null,
 *           replyToSessionId?: string|null, ttlMs?: number, nostrPublicKey?: string|null,
 *           stunServers?: string[] }} params
 */
export function buildDirectMessageInnerPayload({
    identity,
    eciesPublicKey,
    role,
    webrtcDescription,
    sessionId = null,
    replyToSessionId = null,
    ttlMs = DEFAULT_TTL_MS,
    nostrPublicKey = null,
    stunServers = ['stun:stun.l.google.com:19302']
}) {
    if (!identity?.address) throw new Error('Local EVM identity is required.');
    if (!eciesPublicKey) throw new Error('Local ECIES public key is required.');
    if (role !== 'offer' && role !== 'answer') throw new Error('Role must be offer or answer.');
    if (!webrtcDescription?.type || !webrtcDescription?.sdp) throw new Error('WebRTC description is required.');

    const normalizedSessionId = `${sessionId || ''}`.trim();
    if (normalizedSessionId && !/^[a-f0-9]{16,64}$/i.test(normalizedSessionId)) {
        throw new Error('Direct Messenger session id must be 16-64 hex characters.');
    }

    const createdAt = Date.now();
    const resolvedSessionId = normalizedSessionId || randomHex(12);

    const from = { evmAddress: identity.address, eciesPublicKey };
    if (nostrPublicKey) from.nostrPublicKey = `${nostrPublicKey}`.toLowerCase();

    const innerPayload = {
        from,
        webrtc: {
            description: webrtcDescription,
            iceComplete: true,
            stunServers
        },
        session: {
            sessionId: resolvedSessionId,
            replyToSessionId: replyToSessionId || null,
            createdAt,
            expiresAt: createdAt + ttlMs,
            nonce: randomHex(12)
        }
    };

    return { innerPayload, createdAt, expiresAt: createdAt + ttlMs, sessionId: resolvedSessionId };
}

/**
 * Type/version/role checks that do not depend on the encryption scheme.
 *
 * @param {{ envelope: any, expectedType: string, expectedVersion: number }} params
 */
function validateEnvelopeHeader({ envelope, expectedType, expectedVersion }) {
    if (envelope?.type !== expectedType) {
        if (envelope?.type === 'direct-message-bootstrap') {
            throw new Error(
                'This is a legacy v1 Direct Message bootstrap artifact. ' +
                    'The v1 unencrypted protocol is no longer supported. ' +
                    'Please ask your peer to generate a new encrypted invite using the current version.'
            );
        }
        throw new Error('Invalid bootstrap type.');
    }
    if (envelope?.version !== expectedVersion) throw new Error(`Unsupported bootstrap version: ${envelope?.version}.`);
    if (envelope?.role !== 'offer' && envelope?.role !== 'answer') throw new Error('Invalid bootstrap role.');
}

/**
 * @param {{ envelope: any, now: number }} params
 */
function validateEnvelopeTimestamps({ envelope, now }) {
    const envCreatedAt = Number(envelope?.createdAt || 0);
    const envExpiresAt = Number(envelope?.expiresAt || 0);
    if (!envCreatedAt || !envExpiresAt) throw new Error('Invalid bootstrap envelope timestamps.');
    if (envCreatedAt > now + MAX_FUTURE_SKEW_MS) throw new Error('Bootstrap creation time is too far in the future.');
    if (envExpiresAt <= now) throw new Error('Bootstrap is expired.');
}

/**
 * Inner-payload checks shared by every transport: identity binding, SDP/role
 * agreement, TTL, reply-id and single-use replay protection.
 *
 * @param {{ envelope: any, innerPayload: any, fromAddress: string, toKey: string,
 *           now: number, expectedReplyToSessionId?: string|null,
 *           expectedNostrSender?: string|null }} params
 */
function finalizeVerifiedBootstrap({
    envelope,
    innerPayload,
    fromAddress,
    toKey,
    now,
    expectedReplyToSessionId = null,
    expectedNostrSender = null
}) {
    const innerFrom = `${innerPayload?.from?.evmAddress || ''}`.toLowerCase();
    if (!innerFrom || innerFrom !== fromAddress) {
        throw new Error('Decrypted inner payload sender does not match envelope sender.');
    }

    const innerPublicKey = `${innerPayload?.from?.eciesPublicKey || ''}`.trim();
    if (!innerPublicKey) throw new Error('Decrypted inner payload is missing sender ECIES public key.');
    let derivedAddress;
    try {
        derivedAddress = evmAddressFromPublicKey(innerPublicKey).toLowerCase();
    } catch (_) {
        throw new Error('Decrypted inner payload contains an invalid sender ECIES public key.');
    }
    if (derivedAddress !== innerFrom) {
        throw new Error('Decrypted inner payload ECIES public key does not match the claimed sender address.');
    }

    // One key, three identities: the Nostr pubkey that authenticated this
    // invitation must be the x coordinate of the sender's ECIES key.
    if (expectedNostrSender) {
        const normalized = `${innerPublicKey}`.replace(/^0x/, '').toLowerCase();
        if (normalized.slice(2, 66) !== `${expectedNostrSender}`.toLowerCase()) {
            throw new Error('Nostr sender key does not match the ECIES identity inside the invitation.');
        }
    }

    const webrtcType = innerPayload?.webrtc?.description?.type;
    const webrtcSdp = innerPayload?.webrtc?.description?.sdp;
    if (!webrtcSdp) throw new Error('Missing WebRTC SDP in decrypted payload.');
    if (envelope.role === 'offer' && webrtcType !== 'offer') throw new Error('Bootstrap role/type mismatch: expected offer SDP.');
    if (envelope.role === 'answer' && webrtcType !== 'answer') throw new Error('Bootstrap role/type mismatch: expected answer SDP.');

    const innerCreatedAt = Number(innerPayload?.session?.createdAt || 0);
    const innerExpiresAt = Number(innerPayload?.session?.expiresAt || 0);
    if (!innerCreatedAt || !innerExpiresAt) throw new Error('Invalid bootstrap session timestamps.');
    if (innerCreatedAt > now + MAX_FUTURE_SKEW_MS) throw new Error('Bootstrap creation time is too far in the future.');
    if (innerExpiresAt <= now) throw new Error('Bootstrap is expired.');

    const sessionId = `${innerPayload?.session?.sessionId || ''}`;
    const nonce = `${innerPayload?.session?.nonce || ''}`;
    if (!sessionId || !nonce) throw new Error('Invalid bootstrap session fields.');

    const replayKey = `${fromAddress}:${toKey}:${sessionId}:${nonce}`;
    if (replayCache.has(replayKey)) throw new Error('Replay detected for this bootstrap.');

    if (envelope.role === 'answer' && expectedReplyToSessionId) {
        if (innerPayload?.session?.replyToSessionId !== expectedReplyToSessionId) {
            throw new Error('Answer bootstrap does not reference the expected offer session.');
        }
    }

    replayCache.add(replayKey);

    return {
        type: envelope.type,
        version: envelope.version,
        role: envelope.role,
        from: innerPayload.from,
        to: envelope.to,
        webrtc: innerPayload.webrtc,
        session: innerPayload.session
    };
}

/**
 * Build and ECIES-encrypt the sensitive inner DM payload for a given recipient
 * public key. Returns the minimal plaintext envelope and the hex ciphertext.
 *
 * @param {{ identity: {address: string}, eciesPublicKey: string, role: string,
 *           webrtcDescription: RTCSessionDescriptionInit,
 *           recipientPublicKey: string, sessionId?: string|null,
 *           replyToSessionId?: string|null, ttlMs?: number,
 *           nostrPublicKey?: string|null,
 *           encryptFn?: ((plaintext: string, publicKey: string) => Promise<string>)|null }} params
 * @returns {Promise<{ envelope: object, innerPayload: object, envelopeBytes: Uint8Array }>}
 */
export async function createEncryptedDMBootstrapArtifact({
    identity,
    eciesPublicKey,
    role,
    webrtcDescription,
    recipientPublicKey,
    sessionId = null,
    replyToSessionId = null,
    ttlMs = DEFAULT_TTL_MS,
    nostrPublicKey = null,
    encryptFn = null
}) {
    const { publicKey: recipKey, evmAddress: recipientAddress } = validateRecipientPublicKey(recipientPublicKey);

    const { innerPayload, createdAt, expiresAt } = buildDirectMessageInnerPayload({
        identity,
        eciesPublicKey,
        role,
        webrtcDescription,
        sessionId,
        replyToSessionId,
        ttlMs,
        nostrPublicKey
    });

    const encrypt = encryptFn || eciesEncrypt;
    const ciphertext = await encrypt(JSON.stringify(innerPayload), recipKey);

    // Outer envelope — minimal plaintext suitable for routing/pre-decryption checks
    const envelope = {
        type: BOOTSTRAP_TYPE,
        version: BOOTSTRAP_VERSION,
        role,
        from: { evmAddress: identity.address },
        to: { evmAddress: recipientAddress },
        createdAt,
        expiresAt,
        encrypted: {
            algorithm: ECIES_ALGORITHM,
            ciphertext
        }
    };

    const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope, null, 2));
    return { envelope, innerPayload, envelopeBytes };
}

/**
 * Decrypt and validate a v2 DM bootstrap envelope.
 *
 * `decryptFn` performs the ECIES decryption on the caller's behalf. In the app
 * it is backed by the dedicated wallet worker, so the private key is never
 * handed to this module.
 *
 * The sender must be bound by at least one external proof: a verified
 * TorrentChain publisher, or the Nostr key that signed the NIP-59 seal.
 *
 * @param {{ envelope: object, envelopeBuffer?: Uint8Array|ArrayBuffer,
 *           verifiedPublisher?: string|null, expectedNostrSender?: string|null,
 *           localAddress: string,
 *           decryptFn: ((ciphertext: string) => Promise<string>)|null,
 *           expectedFrom?: string|null,
 *           expectedReplyToSessionId?: string|null,
 *           verifyEnvelopeIntegrity?: ((envelopeBuffer: any) => Promise<void>)|null }} params
 * @returns {Promise<object>} merged bootstrap object compatible with consuming code
 */
export async function decryptAndVerifyDMBootstrapArtifact({
    envelope,
    envelopeBuffer,
    verifiedPublisher = null,
    expectedNostrSender = null,
    localAddress,
    decryptFn,
    expectedFrom = null,
    expectedReplyToSessionId = null,
    verifyEnvelopeIntegrity = null
}) {
    const now = Date.now();
    validateEnvelopeHeader({ envelope, expectedType: BOOTSTRAP_TYPE, expectedVersion: BOOTSTRAP_VERSION });

    const fromAddress = `${envelope?.from?.evmAddress || ''}`.toLowerCase();
    const toAddress = `${envelope?.to?.evmAddress || ''}`.toLowerCase();
    const local = `${localAddress || ''}`.toLowerCase();

    if (!verifiedPublisher && !expectedNostrSender) {
        throw new Error('A verified sender binding is required to accept a bootstrap.');
    }
    if (verifiedPublisher) {
        const publisher = `${verifiedPublisher}`.toLowerCase();
        if (!fromAddress || fromAddress !== publisher) throw new Error('Publisher does not match bootstrap sender.');
    }
    if (!fromAddress) throw new Error('Publisher does not match bootstrap sender.');
    if (!toAddress || !local || toAddress !== local) throw new Error('Bootstrap recipient does not match current user.');
    if (expectedFrom && fromAddress !== `${expectedFrom}`.toLowerCase()) throw new Error('Bootstrap sender is not the expected peer.');

    validateEnvelopeTimestamps({ envelope, now });

    if (typeof verifyEnvelopeIntegrity === 'function') await verifyEnvelopeIntegrity(envelopeBuffer);

    const ciphertext = `${envelope?.encrypted?.ciphertext || ''}`;
    const algorithm = `${envelope?.encrypted?.algorithm || ''}`;
    if (algorithm !== ECIES_ALGORITHM) throw new Error(`Unsupported encryption algorithm: ${algorithm}`);
    if (!ciphertext) throw new Error('Missing encrypted ciphertext in bootstrap envelope.');
    if (typeof decryptFn !== 'function') {
        throw new Error('A wallet decryption handle is required to decrypt the bootstrap. Wallet may be locked.');
    }

    let innerPayload;
    try {
        const decrypted = await decryptFn(ciphertext);
        innerPayload = JSON.parse(decrypted);
    } catch (_) {
        throw new Error('Failed to decrypt bootstrap: wrong recipient, corrupted ciphertext, or malformed payload.');
    }

    return finalizeVerifiedBootstrap({
        envelope,
        innerPayload,
        fromAddress,
        toKey: toAddress,
        now,
        expectedReplyToSessionId,
        expectedNostrSender
    });
}

/**
 * Build the Nostr-addressed invitation envelope.
 *
 * Confidentiality for this envelope is provided by the NIP-59 gift wrap it is
 * carried inside — it is never written anywhere a relay could read it in the
 * clear. Authenticity is provided here, by the sender's Web25 secp256k1
 * signature over the payload, produced inside the wallet worker.
 *
 * @param {{ identity: {address: string}, eciesPublicKey: string, nostrPublicKey: string,
 *           role: string, webrtcDescription: RTCSessionDescriptionInit,
 *           recipientNostrPublicKey: string, signFn: (message: string) => Promise<string>,
 *           sessionId?: string|null, replyToSessionId?: string|null, ttlMs?: number }} params
 */
export async function createSealedDMBootstrapArtifact({
    identity,
    eciesPublicKey,
    nostrPublicKey,
    role,
    webrtcDescription,
    recipientNostrPublicKey,
    signFn,
    sessionId = null,
    replyToSessionId = null,
    ttlMs = DEFAULT_TTL_MS
}) {
    const recipient = `${recipientNostrPublicKey || ''}`.trim().toLowerCase();
    if (!HEX32_RE.test(recipient)) throw new Error('Recipient Nostr public key must be 32 bytes of hex.');
    if (typeof signFn !== 'function') {
        throw new Error('A wallet signing handle is required to create an invitation. Wallet may be locked.');
    }

    const { innerPayload, createdAt, expiresAt } = buildDirectMessageInnerPayload({
        identity,
        eciesPublicKey,
        role,
        webrtcDescription,
        sessionId,
        replyToSessionId,
        ttlMs,
        nostrPublicKey
    });

    const payload = JSON.stringify(innerPayload);
    const signature = await signFn(payload);

    const envelope = {
        type: SEALED_BOOTSTRAP_TYPE,
        version: SEALED_BOOTSTRAP_VERSION,
        role,
        from: { evmAddress: identity.address },
        to: { nostrPublicKey: recipient },
        createdAt,
        expiresAt,
        sealed: {
            algorithm: SEALED_ALGORITHM,
            payload,
            signature
        }
    };

    return { envelope, innerPayload };
}

/**
 * Validate a Nostr-addressed invitation envelope.
 *
 * @param {{ envelope: any, senderNostrPublicKey: string, localNostrPublicKey: string,
 *           verifyFn: (message: string, signature: string, publicKey: string) => Promise<boolean>,
 *           localAddress?: string|null, expectedFrom?: string|null,
 *           expectedReplyToSessionId?: string|null }} params
 */
export async function verifySealedDMBootstrapArtifact({
    envelope,
    senderNostrPublicKey,
    localNostrPublicKey,
    verifyFn,
    localAddress = null,
    expectedFrom = null,
    expectedReplyToSessionId = null
}) {
    const now = Date.now();
    validateEnvelopeHeader({ envelope, expectedType: SEALED_BOOTSTRAP_TYPE, expectedVersion: SEALED_BOOTSTRAP_VERSION });
    validateEnvelopeTimestamps({ envelope, now });

    const sender = `${senderNostrPublicKey || ''}`.toLowerCase();
    const local = `${localNostrPublicKey || ''}`.toLowerCase();
    if (!HEX32_RE.test(sender)) throw new Error('A verified Nostr sender key is required to accept an invitation.');
    if (!HEX32_RE.test(local)) throw new Error('The local Nostr identity is unavailable; unlock the wallet first.');

    const toKey = `${envelope?.to?.nostrPublicKey || ''}`.toLowerCase();
    if (!toKey || toKey !== local) throw new Error('Bootstrap recipient does not match current user.');

    const fromAddress = `${envelope?.from?.evmAddress || ''}`.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(fromAddress)) throw new Error('Invitation carries an invalid sender address.');
    if (expectedFrom && fromAddress !== `${expectedFrom}`.toLowerCase()) throw new Error('Bootstrap sender is not the expected peer.');

    if (`${envelope?.sealed?.algorithm || ''}` !== SEALED_ALGORITHM) {
        throw new Error(`Unsupported encryption algorithm: ${envelope?.sealed?.algorithm}`);
    }

    const payload = `${envelope?.sealed?.payload || ''}`;
    const signature = `${envelope?.sealed?.signature || ''}`;
    if (!payload || !signature) throw new Error('Invitation is missing its signed payload.');

    let innerPayload;
    try {
        innerPayload = JSON.parse(payload);
    } catch (_) {
        throw new Error('Failed to decrypt bootstrap: wrong recipient, corrupted ciphertext, or malformed payload.');
    }

    const senderEciesKey = `${innerPayload?.from?.eciesPublicKey || ''}`.trim();
    if (!senderEciesKey) throw new Error('Decrypted inner payload is missing sender ECIES public key.');

    const signatureValid = await verifyFn(payload, signature, senderEciesKey);
    if (!signatureValid) throw new Error('Invitation signature verification failed: possible tampering.');

    if (localAddress) {
        // The invitation names the EVM identity it is meant for only implicitly
        // (through the Nostr address); this is the explicit cross-check.
        const claimed = `${envelope?.to?.evmAddress || ''}`.toLowerCase();
        if (claimed && claimed !== `${localAddress}`.toLowerCase()) {
            throw new Error('Bootstrap recipient does not match current user.');
        }
    }

    return finalizeVerifiedBootstrap({
        envelope,
        innerPayload,
        fromAddress,
        toKey,
        now,
        expectedReplyToSessionId,
        expectedNostrSender: sender
    });
}
