// @ts-check
/**
 * WebTorrent transport for the Direct Messenger bootstrap.
 *
 * The envelope format, TTL, session-id/reply-id handling, validation and
 * replay protection live in the transport-neutral `DirectMessageBootstrapCore`
 * module and are shared with the Nostr transport. What is specific to this
 * file is the WebTorrent part: seeding the envelope inside a signed
 * `.torrentchain` artifact, and binding the sender to the publisher that
 * TorrentChain verified.
 */

import { createTorrentChainArtifact, verifyTorrentChainManifest } from '../torrent/TorrentChainProtocol.js';
import {
    BOOTSTRAP_FILE_NAME,
    createEncryptedDMBootstrapArtifact,
    decryptAndVerifyDMBootstrapArtifact
} from './DirectMessageBootstrapCore.js';

export { createEncryptedDMBootstrapArtifact, decryptAndVerifyDMBootstrapArtifact };

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
    decryptFn = null,
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
        decryptFn,
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
    decryptFn = null,
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
        decryptFn,
        expectedFrom,
        expectedReplyToSessionId,
        // Bind the envelope bytes to the signed TorrentChain manifest before
        // any ciphertext is handed to the wallet worker.
        verifyEnvelopeIntegrity: async (buffer) => {
            const hashVerification = await verifyLocalBootstrapFileHash(manifest, BOOTSTRAP_FILE_NAME, buffer);
            if (!hashVerification.ok) {
                throw new Error(`dm-bootstrap.json integrity verification failed: ${hashVerification.reason}`);
            }
        }
    });
}
