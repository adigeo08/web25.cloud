// @ts-check

import { createTorrentChainArtifact, verifyTorrentChainManifest } from '../torrent/TorrentChainProtocol.js';
import { evmAddressFromPublicKey } from './ecies.js';

const BOOTSTRAP_FILE_NAME = 'dm-bootstrap.json';
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

export async function createDirectMessageBootstrapTorrent({
    client,
    trackers = [],
    identity,
    recipientAddress,
    role,
    webrtcDescription,
    eciesPublicKey,
    replyToSessionId = null,
    replyToContainerKey = null
}) {
    if (!client) throw new Error('WebTorrent client is required.');
    if (!identity?.address) throw new Error('Local EVM identity is required.');
    if (role === 'answer' && !recipientAddress) throw new Error('Recipient EVM address is required for answer bootstrap.');
    if (!eciesPublicKey) throw new Error('ECIES public key is required for Direct Messenger bootstrap.');
    if (role !== 'offer' && role !== 'answer') throw new Error('Role must be offer or answer.');
    if (!webrtcDescription?.type || !webrtcDescription?.sdp) throw new Error('WebRTC description is required.');

    const createdAt = Date.now();
    const bootstrap = {
        type: 'direct-message-bootstrap',
        version: 1,
        role,
        from: {
            evmAddress: identity.address,
            eciesPublicKey
        },
        to: {
            evmAddress: recipientAddress || '*'
        },
        webrtc: {
            description: webrtcDescription,
            iceComplete: true,
            stunServers: ['stun:stun.l.google.com:19302']
        },
        session: {
            sessionId: randomHex(12),
            containerKey: randomHex(32),
            replyToSessionId,
            replyToContainerKey,
            createdAt,
            expiresAt: createdAt + DEFAULT_TTL_MS,
            nonce: randomHex(12)
        }
    };

    const bootstrapBytes = new TextEncoder().encode(JSON.stringify(bootstrap, null, 2));
    const bootstrapFile = makeVirtualFile(BOOTSTRAP_FILE_NAME, bootstrapBytes);

    const chainArtifact = await createTorrentChainArtifact({
        inMemoryFiles: [bootstrapFile],
        publisher: identity.address,
        chainId: identity.chainId || 1,
        identityType: identity.identityType,
        createdAt
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
            [chainFile, bootstrapFile],
            {
                announce: trackers,
                name: `dm-${role}-${bootstrap.session.sessionId}`,
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

    return { magnetURI: torrent.magnetURI, infoHash: torrent.infoHash, bootstrap };
}

export async function loadDirectMessageBootstrapFromMagnet({
    client,
    magnetURI,
    localAddress,
    expectedFrom = null,
    expectedReplyToSessionId = null,
    expectedReplyToContainerKey = null,
    trackers = []
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
    const bootstrapFile = findTorrentFile(torrent, BOOTSTRAP_FILE_NAME);
    if (!chainFile || !bootstrapFile) throw new Error('Missing .torrentchain or dm-bootstrap.json in torrent.');

    const [manifestBuffer, bootstrapBuffer] = await Promise.all([readTorrentFileBuffer(chainFile), readTorrentFileBuffer(bootstrapFile)]);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBuffer));
    const bootstrap = JSON.parse(new TextDecoder().decode(bootstrapBuffer));

    await verifyDirectMessageTorrentchain({
        manifest,
        bootstrap,
        bootstrapBuffer,
        localAddress,
        expectedFrom,
        expectedReplyToSessionId,
        expectedReplyToContainerKey
    });

    return bootstrap;
}

export async function verifyDirectMessageTorrentchain({
    manifest,
    bootstrap,
    bootstrapBuffer,
    localAddress,
    expectedFrom = null,
    expectedReplyToSessionId = null,
    expectedReplyToContainerKey = null
}) {
    if (bootstrap?.type !== 'direct-message-bootstrap') throw new Error('Invalid bootstrap type.');
    if (bootstrap?.version !== 1) throw new Error('Unsupported bootstrap version.');
    if (bootstrap?.role !== 'offer' && bootstrap?.role !== 'answer') throw new Error('Invalid bootstrap role.');
    const webrtcType = bootstrap?.webrtc?.description?.type;
    const webrtcSdp = bootstrap?.webrtc?.description?.sdp;
    if (!webrtcSdp) throw new Error('Missing WebRTC SDP in bootstrap payload.');
    if (bootstrap.role === 'offer' && webrtcType !== 'offer') throw new Error('Bootstrap role/type mismatch: expected offer.');
    if (bootstrap.role === 'answer' && webrtcType !== 'answer') throw new Error('Bootstrap role/type mismatch: expected answer.');

    const sig = await verifyTorrentChainManifest(manifest);
    if (!sig.verified) throw new Error('Invalid .torrentchain signature.');

    const from = `${bootstrap?.from?.evmAddress || ''}`.toLowerCase();
    const to = `${bootstrap?.to?.evmAddress || ''}`.toLowerCase();
    const publisher = `${sig.publisher || ''}`.toLowerCase();
    const local = `${localAddress || ''}`.toLowerCase();

    if (!from || from !== publisher) throw new Error('Publisher does not match bootstrap sender.');
    const isWildcardRecipient = !to || to === '*' || to === 'any';
    if (bootstrap?.role === 'answer' && (!to || !local || to !== local)) {
        throw new Error('Bootstrap recipient does not match current user.');
    }
    if (bootstrap?.role === 'offer' && !isWildcardRecipient && (!local || to !== local)) {
        throw new Error('Bootstrap recipient does not match current user.');
    }
    if (expectedFrom && from !== `${expectedFrom}`.toLowerCase()) throw new Error('Bootstrap sender is not the expected peer.');
    const bootstrapPublicKey = `${bootstrap?.from?.eciesPublicKey || ''}`.trim();
    if (!bootstrapPublicKey) throw new Error('Bootstrap is missing sender ECIES public key.');
    const derived = evmAddressFromPublicKey(bootstrapPublicKey).toLowerCase();
    if (derived !== from) {
        throw new Error('Bootstrap ECIES public key does not match the claimed sender address.');
    }

    const now = Date.now();
    const createdAt = Number(bootstrap?.session?.createdAt || 0);
    const expiresAt = Number(bootstrap?.session?.expiresAt || 0);
    if (!createdAt || !expiresAt) throw new Error('Invalid bootstrap session timestamps.');
    if (createdAt > now + MAX_FUTURE_SKEW_MS) throw new Error('Bootstrap creation time is too far in the future.');
    if (expiresAt <= now) throw new Error('Bootstrap is expired.');

    const sessionId = `${bootstrap?.session?.sessionId || ''}`;
    const nonce = `${bootstrap?.session?.nonce || ''}`;
    const replayKey = `${from}:${to}:${sessionId}:${nonce}`;
    if (!sessionId || !nonce) throw new Error('Invalid bootstrap session fields.');
    if (replayCache.has(replayKey)) throw new Error('Replay detected for this bootstrap.');

    if (bootstrap?.role === 'answer' && expectedReplyToSessionId) {
        if (bootstrap?.session?.replyToSessionId !== expectedReplyToSessionId) {
            throw new Error('Answer bootstrap does not reference the expected offer session.');
        }
    }
    if (bootstrap?.role === 'answer' && expectedReplyToContainerKey) {
        if (bootstrap?.session?.replyToContainerKey !== expectedReplyToContainerKey) {
            throw new Error('Answer bootstrap does not reference the expected offer container key.');
        }
    }

    const hashVerification = await verifyLocalBootstrapFileHash(manifest, BOOTSTRAP_FILE_NAME, bootstrapBuffer);
    if (!hashVerification.ok) throw new Error(`dm-bootstrap.json integrity verification failed: ${hashVerification.reason}`);
    replayCache.add(replayKey);

    return true;
}
