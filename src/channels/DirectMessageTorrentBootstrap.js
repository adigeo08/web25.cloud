// @ts-check

import { createTorrentChainArtifact, verifyTorrentChainManifest } from '../torrent/TorrentChainProtocol.js';
import { eciesEncrypt, eciesDecrypt, evmAddressFromPublicKey } from './ecies.js';

const BOOTSTRAP_FILE_NAME = 'dm-bootstrap.json';
const BOOTSTRAP_TYPE = 'direct-message-bootstrap-v2';
const BOOTSTRAP_VERSION = 2;
const ECIES_ALGORITHM = 'ECIES-secp256k1-HKDF-SHA256-AES-256-GCM';
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const replayCache = new Set();

function randomHex(bytes = 8) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

function makeVirtualFile(name, bytes, type = 'application/json') {
    return new File([bytes], name, { type });
}

function readTorrentFileBuffer(file) {
    return new Promise((resolve, reject) => {
        file.getBuffer((error, buffer) => {
            if (error) return reject(error);
            resolve(buffer);
        });
    });
}

function findTorrentFile(torrent, fileName) {
    const wanted = `${fileName || ''}`.toLowerCase();
    return torrent.files.find((file) => {
        const normalized = `${file.name || ''}`.toLowerCase();
        return normalized === wanted || normalized.endsWith(`/${wanted}`);
    });
}

async function verifyLocalBootstrapFileHash(manifest, fileName, fileBytes) {
    const files = Array.isArray(manifest?.payload?.files)
        ? manifest.payload.files
        : Array.isArray(manifest?.files)
          ? manifest.files
          : null;
    if (!files) {
        return { ok: false, reason: 'missing-file-hash-collection' };
    }
    const normalized = `${fileName || ''}`.replace(/\\/g, '/').replace(/^\/+/, '');
    const record = files.find((entry) => {
        const path = `${entry?.path || ''}`.replace(/\\/g, '/').replace(/^\/+/, '');
        return path === normalized || path.endsWith(`/${normalized}`);
    });
    if (!record?.sha256) return { ok: false, reason: 'missing-file-hash-record' };
    const digest = await crypto.subtle.digest('SHA-256', fileBytes);
    const hashHex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return { ok: hashHex === record.sha256, reason: hashHex === record.sha256 ? 'ok' : 'file-hash-mismatch' };
}

/**
 * Validate a recipient ECIES public key and derive its EVM address.
 * @param {string} publicKeyHex
 * @returns {{ publicKey: string, evmAddress: string }}
 */
function validateRecipientPublicKey(publicKeyHex) {
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
 * Build and ECIES-encrypt the sensitive inner DM payload for a given recipient public key.
 * Returns the minimal plaintext envelope and the hex ciphertext.
 *
 * @param {{ identity: {address: string}, eciesPublicKey: string, role: string,
 *           webrtcDescription: RTCSessionDescriptionInit,
 *           recipientPublicKey: string, sessionId?: string|null,
 *           replyToSessionId?: string|null, ttlMs?: number }} params
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
    ttlMs = DEFAULT_TTL_MS
}) {
    if (!identity?.address) throw new Error('Local EVM identity is required.');
    if (!eciesPublicKey) throw new Error('Local ECIES public key is required.');
    if (role !== 'offer' && role !== 'answer') throw new Error('Role must be offer or answer.');
    if (!webrtcDescription?.type || !webrtcDescription?.sdp) throw new Error('WebRTC description is required.');

    const { publicKey: recipKey, evmAddress: recipientAddress } = validateRecipientPublicKey(recipientPublicKey);

    const normalizedSessionId = `${sessionId || ''}`.trim();
    if (normalizedSessionId && !/^[a-f0-9]{16,64}$/i.test(normalizedSessionId)) {
        throw new Error('Direct Messenger session id must be 16-64 hex characters.');
    }

    const createdAt = Date.now();
    const resolvedSessionId = normalizedSessionId || randomHex(12);
    const nonce = randomHex(12);

    // Inner payload — encrypted; contains all sensitive data
    const innerPayload = {
        from: {
            evmAddress: identity.address,
            eciesPublicKey
        },
        webrtc: {
            description: webrtcDescription,
            iceComplete: true,
            stunServers: ['stun:stun.l.google.com:19302']
        },
        session: {
            sessionId: resolvedSessionId,
            replyToSessionId: replyToSessionId || null,
            createdAt,
            expiresAt: createdAt + ttlMs,
            nonce
        }
    };

    const ciphertext = await eciesEncrypt(JSON.stringify(innerPayload), recipKey);

    // Outer envelope — minimal plaintext suitable for routing/pre-decryption checks
    const envelope = {
        type: BOOTSTRAP_TYPE,
        version: BOOTSTRAP_VERSION,
        role,
        from: { evmAddress: identity.address },
        to: { evmAddress: recipientAddress },
        createdAt,
        expiresAt: createdAt + ttlMs,
        encrypted: {
            algorithm: ECIES_ALGORITHM,
            ciphertext
        }
    };

    const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope, null, 2));
    return { envelope, innerPayload, envelopeBytes };
}

/**
 * Decrypt and validate a v2 DM bootstrap envelope without calling TorrentChain.
 * Accepts the already-verified publisher from the caller (e.g. from verifyTorrentChainManifest).
 *
 * @param {{ envelope: object, envelopeBuffer: Uint8Array|ArrayBuffer,
 *           verifiedPublisher: string, localAddress: string,
 *           localPrivateKey: string|null,
 *           expectedFrom?: string|null,
 *           expectedReplyToSessionId?: string|null,
 *           manifest?: object }} params
 * @returns {Promise<object>} merged bootstrap object compatible with consuming code
 */
export async function decryptAndVerifyDMBootstrapArtifact({
    envelope,
    envelopeBuffer,
    verifiedPublisher,
    localAddress,
    localPrivateKey,
    expectedFrom = null,
    expectedReplyToSessionId = null,
    manifest = null
}) {
    if (envelope?.type !== BOOTSTRAP_TYPE) {
        if (envelope?.type === 'direct-message-bootstrap') {
            throw new Error(
                'This is a legacy v1 Direct Message bootstrap artifact. ' +
                    'The v1 unencrypted protocol is no longer supported. ' +
                    'Please ask your peer to generate a new encrypted invite using the current version.'
            );
        }
        throw new Error('Invalid bootstrap type.');
    }
    if (envelope?.version !== BOOTSTRAP_VERSION) throw new Error(`Unsupported bootstrap version: ${envelope?.version}.`);
    if (envelope?.role !== 'offer' && envelope?.role !== 'answer') throw new Error('Invalid bootstrap role.');

    const fromAddress = `${envelope?.from?.evmAddress || ''}`.toLowerCase();
    const toAddress = `${envelope?.to?.evmAddress || ''}`.toLowerCase();
    const publisher = `${verifiedPublisher || ''}`.toLowerCase();
    const local = `${localAddress || ''}`.toLowerCase();

    if (!fromAddress || fromAddress !== publisher) throw new Error('Publisher does not match bootstrap sender.');
    if (!toAddress || !local || toAddress !== local) throw new Error('Bootstrap recipient does not match current user.');
    if (expectedFrom && fromAddress !== `${expectedFrom}`.toLowerCase()) throw new Error('Bootstrap sender is not the expected peer.');

    const now = Date.now();
    const envCreatedAt = Number(envelope?.createdAt || 0);
    const envExpiresAt = Number(envelope?.expiresAt || 0);
    if (!envCreatedAt || !envExpiresAt) throw new Error('Invalid bootstrap envelope timestamps.');
    if (envCreatedAt > now + MAX_FUTURE_SKEW_MS) throw new Error('Bootstrap creation time is too far in the future.');
    if (envExpiresAt <= now) throw new Error('Bootstrap is expired.');

    // Verify envelope file hash against torrentchain manifest
    if (manifest) {
        const hashVerification = await verifyLocalBootstrapFileHash(manifest, BOOTSTRAP_FILE_NAME, envelopeBuffer);
        if (!hashVerification.ok) throw new Error(`dm-bootstrap.json integrity verification failed: ${hashVerification.reason}`);
    }

    // Decrypt inner payload
    const ciphertext = `${envelope?.encrypted?.ciphertext || ''}`;
    const algorithm = `${envelope?.encrypted?.algorithm || ''}`;
    if (algorithm !== ECIES_ALGORITHM) throw new Error(`Unsupported encryption algorithm: ${algorithm}`);
    if (!ciphertext) throw new Error('Missing encrypted ciphertext in bootstrap envelope.');
    if (!localPrivateKey) throw new Error('Local private key is required to decrypt the bootstrap. Wallet may be locked.');

    let innerPayload;
    try {
        const decrypted = await eciesDecrypt(ciphertext, localPrivateKey);
        innerPayload = JSON.parse(decrypted);
    } catch (_) {
        throw new Error('Failed to decrypt bootstrap: wrong recipient, corrupted ciphertext, or malformed payload.');
    }

    // Validate inner payload consistency
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

    const replayKey = `${fromAddress}:${toAddress}:${sessionId}:${nonce}`;
    if (replayCache.has(replayKey)) throw new Error('Replay detected for this bootstrap.');

    if (envelope.role === 'answer' && expectedReplyToSessionId) {
        if (innerPayload?.session?.replyToSessionId !== expectedReplyToSessionId) {
            throw new Error('Answer bootstrap does not reference the expected offer session.');
        }
    }

    replayCache.add(replayKey);

    // Return a merged object for backward compatibility with consuming code
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

export async function createDirectMessageBootstrapTorrent({
    client,
    trackers = [],
    identity,
    recipientPublicKey,
    role,
    webrtcDescription,
    eciesPublicKey,
    replyToSessionId = null,
    sessionId = null
}) {
    if (!client) throw new Error('WebTorrent client is required.');

    const { envelope, innerPayload, envelopeBytes } = await createEncryptedDMBootstrapArtifact({
        identity,
        eciesPublicKey,
        role,
        webrtcDescription,
        recipientPublicKey,
        sessionId,
        replyToSessionId
    });

    const envelopeFile = makeVirtualFile(BOOTSTRAP_FILE_NAME, envelopeBytes);

    const chainArtifact = await createTorrentChainArtifact({
        inMemoryFiles: [envelopeFile],
        publisher: identity.address,
        chainId: identity.chainId || 1,
        identityType: identity.identityType,
        createdAt: envelope.createdAt
    });
    const chainFile = makeVirtualFile('.torrentchain', chainArtifact.content);

    const torrent = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out while seeding Direct Message bootstrap torrent.')), 10000);
        const doneReject = (error) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const doneResolve = (result) => {
            clearTimeout(timer);
            resolve(result);
        };
        client.seed(
            [chainFile, envelopeFile],
            {
                announce: trackers,
                name: `dm-${role}`,
                comment: 'Web25 Direct Message bootstrap'
            },
            (result) => {
                if (!result || !result.magnetURI) {
                    doneReject(new Error('Failed to seed Direct Message bootstrap torrent: missing magnet URI.'));
                    return;
                }
                doneResolve(result);
            }
        );
    });

    // Expose merged bootstrap shape for consuming code
    const bootstrap = {
        type: envelope.type,
        version: envelope.version,
        role: envelope.role,
        from: innerPayload.from,
        to: envelope.to,
        webrtc: innerPayload.webrtc,
        session: innerPayload.session
    };

    return { magnetURI: torrent.magnetURI, infoHash: torrent.infoHash, bootstrap };
}

export async function loadDirectMessageBootstrapFromMagnet({
    client,
    magnetURI,
    localAddress,
    localPrivateKey = null,
    expectedFrom = null,
    expectedReplyToSessionId = null,
    trackers = [],
    // @internal — injectable manifest verifier for unit testing; do not use in production
    _verifyManifestFn = null
}) {
    if (!client) throw new Error('WebTorrent client is required.');
    if (!magnetURI || !`${magnetURI}`.startsWith('magnet:?')) throw new Error('Valid magnet URI is required.');

    const trackerList = (trackers || []).map((trackerUrl) => encodeURIComponent(trackerUrl));
    const trackerQuery = trackerList.length > 0 ? `&tr=${trackerList.join('&tr=')}` : '';
    const finalMagnet = magnetURI.includes('&tr=') ? magnetURI : `${magnetURI}${trackerQuery}`;
    const torrent = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out while loading Direct Message magnet.')), 15000);
        const doneResolve = (value) => {
            clearTimeout(timer);
            resolve(value);
        };
        const doneReject = (error) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        client.add(finalMagnet, (added) => {
            if (!added?.files || added.files.length === 0) {
                added.once?.('metadata', () => doneResolve(added));
                added.once?.('error', doneReject);
                return;
            }
            doneResolve(added);
        });
    });

    const chainFile = findTorrentFile(torrent, '.torrentchain');
    const envelopeFile = findTorrentFile(torrent, BOOTSTRAP_FILE_NAME);
    if (!chainFile || !envelopeFile) throw new Error('Missing .torrentchain or dm-bootstrap.json in torrent.');

    const [manifestBuffer, envelopeBuffer] = await Promise.all([readTorrentFileBuffer(chainFile), readTorrentFileBuffer(envelopeFile)]);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBuffer));
    const envelope = JSON.parse(new TextDecoder().decode(envelopeBuffer));

    return verifyDirectMessageTorrentchain({
        manifest,
        envelope,
        envelopeBuffer,
        localAddress,
        localPrivateKey,
        expectedFrom,
        expectedReplyToSessionId,
        _verifyManifestFn
    });
}

export async function verifyDirectMessageTorrentchain({
    manifest,
    envelope,
    envelopeBuffer,
    localAddress,
    localPrivateKey = null,
    expectedFrom = null,
    expectedReplyToSessionId = null,
    // @internal — injectable for unit testing; production always uses verifyTorrentChainManifest
    _verifyManifestFn = null
}) {
    const verifyFn = _verifyManifestFn || verifyTorrentChainManifest;
    const sig = await verifyFn(manifest);
    if (!sig.verified) throw new Error('Invalid .torrentchain signature.');

    return decryptAndVerifyDMBootstrapArtifact({
        envelope,
        envelopeBuffer,
        verifiedPublisher: sig.publisher,
        localAddress,
        localPrivateKey,
        expectedFrom,
        expectedReplyToSessionId,
        manifest
    });
}
