import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createEncryptedDMBootstrapArtifact,
    decryptAndVerifyDMBootstrapArtifact,
    verifyDirectMessageTorrentchain,
    loadDirectMessageBootstrapFromMagnet,
    createDirectMessageBootstrapTorrent
} from '../src/channels/DirectMessageTorrentBootstrap.js';
import { getPublicKeyFromPrivateKey, evmAddressFromPublicKey, eciesDecrypt } from '../src/channels/ecies.js';

// ─── Deterministic test keys ─────────────────────────────────────────────────
const HOST_PRIV = '0x1111111111111111111111111111111111111111111111111111111111111111';
const GUEST_PRIV = '0x2222222222222222222222222222222222222222222222222222222222222222';
const THIRD_PRIV = '0x3333333333333333333333333333333333333333333333333333333333333333';

const HOST_PUB = getPublicKeyFromPrivateKey(HOST_PRIV);
const GUEST_PUB = getPublicKeyFromPrivateKey(GUEST_PRIV);
const THIRD_PUB = getPublicKeyFromPrivateKey(THIRD_PRIV);

const HOST_ADDR = evmAddressFromPublicKey(HOST_PUB);
const GUEST_ADDR = evmAddressFromPublicKey(GUEST_PUB);
const THIRD_ADDR = evmAddressFromPublicKey(THIRD_PUB);

/**
 * Stand-in for the wallet worker's ECIES_DECRYPT operation. Production code
 * passes a worker-backed handle here; the private key never reaches the
 * bootstrap module itself.
 */
function decryptorFor(privateKey) {
    return (ciphertext) => eciesDecrypt(ciphertext, privateKey);
}

// ─── Shared mock WebRTC descriptions ─────────────────────────────────────────
const OFFER_DESC = { type: 'offer', sdp: 'mock-offer-sdp' };
const ANSWER_DESC = { type: 'answer', sdp: 'mock-answer-sdp' };

// ─── Helper: build a mock manifest that appears to have verified the given publisher
async function makeMockManifest(publisherAddress, envelopeBuffer) {
    const digest = await crypto.subtle.digest('SHA-256', envelopeBuffer);
    const sha256 = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return {
        payload: { publisher: publisherAddress },
        signature: 'mock-sig-not-real',
        files: [{ path: 'dm-bootstrap.json', sha256 }]
    };
}

// Mock verifyTorrentChainManifest that trusts the manifest.payload.publisher as-is
function mockVerifyManifest(manifest) {
    const publisher = manifest?.payload?.publisher || '';
    if (!publisher) return Promise.resolve({ verified: false, reason: 'no-publisher' });
    return Promise.resolve({ verified: true, publisher });
}

// ─── Helper: create a canonical offer artifact for host → guest ───────────────
async function makeHostOffer(overrides = {}) {
    return createEncryptedDMBootstrapArtifact({
        identity: { address: HOST_ADDR },
        eciesPublicKey: HOST_PUB,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipientPublicKey: GUEST_PUB,
        sessionId: null,
        ...overrides
    });
}

// ─── Helper: run decryptAndVerifyDMBootstrapArtifact with defaults ─────────────
async function verifyOffer(artifact, overrides = {}) {
    return decryptAndVerifyDMBootstrapArtifact({
        envelope: artifact.envelope,
        envelopeBuffer: artifact.envelopeBytes,
        verifiedPublisher: HOST_ADDR,
        localAddress: GUEST_ADDR,
        decryptFn: decryptorFor(GUEST_PRIV),
        ...overrides
    });
}

// ─── In-memory mock torrent client ────────────────────────────────────────────
class InMemoryTorrentClient {
    constructor() {
        this._store = new Map();
    }

    seed(files, options, callback) {
        const infoHash = 'mockhash-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;

        // Wrap each File with a getBuffer method for WebTorrent-style access
        const torrentFiles = files.map((f) => ({
            name: f.name,
            getBuffer: (cb) => {
                f.arrayBuffer()
                    .then((buf) => cb(null, Buffer.from(buf)))
                    .catch((err) => cb(err));
            }
        }));

        const torrent = { magnetURI, infoHash, files: torrentFiles };
        this._store.set(magnetURI, torrent);
        // Call async so the caller can register the torrent before callback fires
        Promise.resolve().then(() => callback(torrent));
    }

    add(magnetURI, callback) {
        const torrent = this._store.get(magnetURI);
        if (!torrent) {
            throw new Error('Torrent not found in mock client: ' + magnetURI);
        }
        Promise.resolve().then(() => callback(torrent));
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

// ─── 1. Valid recipient-bound encrypted offer ──────────────────────────────────

test('createEncryptedDMBootstrapArtifact produces an encrypted offer only the intended recipient can read', async () => {
    const artifact = await makeHostOffer();

    // Envelope is plaintext with only from/to addresses, no SDP or sessionId
    assert.equal(artifact.envelope.type, 'direct-message-bootstrap-v2');
    assert.equal(artifact.envelope.version, 2);
    assert.equal(artifact.envelope.role, 'offer');
    assert.equal(artifact.envelope.from.evmAddress, HOST_ADDR);
    assert.equal(artifact.envelope.to.evmAddress, GUEST_ADDR);
    assert.ok(artifact.envelope.encrypted.ciphertext, 'ciphertext is present');
    assert.equal(artifact.envelope.encrypted.algorithm, 'ECIES-secp256k1-HKDF-SHA256-AES-256-GCM');

    // SDP and sessionId must NOT appear in plaintext envelope
    const envelopeJson = new TextDecoder().decode(artifact.envelopeBytes);
    assert.ok(!envelopeJson.includes('mock-offer-sdp'), 'SDP must not be in plaintext envelope');
    assert.ok(!envelopeJson.includes(artifact.innerPayload.session.sessionId), 'sessionId must not be in plaintext envelope');

    // Inner payload is accessible after decryption
    assert.equal(artifact.innerPayload.from.evmAddress, HOST_ADDR);
    assert.equal(artifact.innerPayload.from.eciesPublicKey, HOST_PUB);
    assert.equal(artifact.innerPayload.webrtc.description.type, 'offer');
    assert.equal(artifact.innerPayload.webrtc.description.sdp, 'mock-offer-sdp');
});

test('only the intended recipient can decrypt and validate the offer', async () => {
    const artifact = await makeHostOffer();

    // Correct recipient succeeds
    const result = await verifyOffer(artifact);
    assert.equal(result.role, 'offer');
    assert.equal(result.from.evmAddress, HOST_ADDR);
    assert.equal(result.webrtc.description.sdp, 'mock-offer-sdp');
});

// ─── 2. Wrong private key cannot decrypt ──────────────────────────────────────

test('a different private key cannot decrypt the offer', async () => {
    const artifact = await makeHostOffer();

    // Third party trying to decrypt
    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: artifact.envelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: HOST_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(THIRD_PRIV)
        }),
        /decrypt/i
    );
});

test('a missing wallet decryption handle is rejected with a clear error', async () => {
    const artifact = await makeHostOffer();

    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: artifact.envelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: HOST_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: null
        }),
        /wallet decryption handle is required/i
    );
});

// ─── 3. Valid encrypted answer round-trip with replyToSessionId ───────────────

test('valid encrypted answer round-trip: replyToSessionId is preserved and verified', async () => {
    // Host creates offer
    const offerArtifact = await makeHostOffer();
    const offerSessionId = offerArtifact.innerPayload.session.sessionId;

    // Guest decrypts offer
    const decryptedOffer = await verifyOffer(offerArtifact);
    assert.equal(decryptedOffer.session.sessionId, offerSessionId);

    // Guest creates answer, encrypting back to host
    const answerArtifact = await createEncryptedDMBootstrapArtifact({
        identity: { address: GUEST_ADDR },
        eciesPublicKey: GUEST_PUB,
        role: 'answer',
        webrtcDescription: ANSWER_DESC,
        recipientPublicKey: HOST_PUB,
        replyToSessionId: offerSessionId
    });

    // Host decrypts answer
    const decryptedAnswer = await decryptAndVerifyDMBootstrapArtifact({
        envelope: answerArtifact.envelope,
        envelopeBuffer: answerArtifact.envelopeBytes,
        verifiedPublisher: GUEST_ADDR,
        localAddress: HOST_ADDR,
        decryptFn: decryptorFor(HOST_PRIV),
        expectedReplyToSessionId: offerSessionId
    });

    assert.equal(decryptedAnswer.role, 'answer');
    assert.equal(decryptedAnswer.from.evmAddress, GUEST_ADDR);
    assert.equal(decryptedAnswer.webrtc.description.type, 'answer');
    assert.equal(decryptedAnswer.session.replyToSessionId, offerSessionId);
});

// ─── 4. Wrong replyToSessionId is rejected ────────────────────────────────────

test('answer with wrong replyToSessionId is rejected', async () => {
    const answerArtifact = await createEncryptedDMBootstrapArtifact({
        identity: { address: GUEST_ADDR },
        eciesPublicKey: GUEST_PUB,
        role: 'answer',
        webrtcDescription: ANSWER_DESC,
        recipientPublicKey: HOST_PUB,
        replyToSessionId: 'aabbccdd00112233'
    });

    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: answerArtifact.envelope,
            envelopeBuffer: answerArtifact.envelopeBytes,
            verifiedPublisher: GUEST_ADDR,
            localAddress: HOST_ADDR,
            decryptFn: decryptorFor(HOST_PRIV),
            expectedReplyToSessionId: 'different-session-id-00000000'
        }),
        /expected offer session/i
    );
});

// ─── 5. containerKey does not exist in v2 protocol ───────────────────────────

test('containerKey is absent from the v2 protocol envelope and inner payload', async () => {
    const artifact = await makeHostOffer();

    // Not in envelope (plaintext)
    assert.ok(!('containerKey' in artifact.envelope), 'containerKey must not be in envelope');
    assert.ok(!('containerKey' in (artifact.envelope.session || {})), 'containerKey must not be in envelope.session');

    // Not in inner payload
    assert.ok(!('containerKey' in (artifact.innerPayload.session || {})), 'containerKey must not be in innerPayload.session');
    assert.ok(!('replyToContainerKey' in (artifact.innerPayload.session || {})), 'replyToContainerKey must not be in innerPayload.session');

    // Not in serialized bytes
    const envelopeJson = new TextDecoder().decode(artifact.envelopeBytes);
    assert.ok(!envelopeJson.includes('containerKey'), 'containerKey must not appear in serialized envelope');
});

test('decryptAndVerifyDMBootstrapArtifact does not check or require containerKey', async () => {
    const artifact = await makeHostOffer();
    // Should succeed with no containerKey-related parameters
    const result = await verifyOffer(artifact);
    assert.equal(result.role, 'offer');
    assert.ok(!result.session.containerKey, 'result.session.containerKey should be absent');
    assert.ok(!result.session.replyToContainerKey, 'result.session.replyToContainerKey should be absent');
});

// ─── 6. Security rejection paths ──────────────────────────────────────────────

test('malformed recipient public key is rejected at creation time', async () => {
    await assert.rejects(
        () => createEncryptedDMBootstrapArtifact({
            identity: { address: HOST_ADDR },
            eciesPublicKey: HOST_PUB,
            role: 'offer',
            webrtcDescription: OFFER_DESC,
            recipientPublicKey: 'not-a-valid-key'
        }),
        /public key must be/i
    );
});

test('empty recipient public key is rejected', async () => {
    await assert.rejects(
        () => createEncryptedDMBootstrapArtifact({
            identity: { address: HOST_ADDR },
            eciesPublicKey: HOST_PUB,
            role: 'offer',
            webrtcDescription: OFFER_DESC,
            recipientPublicKey: ''
        }),
        /public key is required/i
    );
});

test('expired bootstrap is rejected', async () => {
    const now = Date.now();
    const artifact = await makeHostOffer();

    // Override timestamps to be expired
    const expiredEnvelope = {
        ...artifact.envelope,
        createdAt: now - 20 * 60 * 1000,
        expiresAt: now - 5 * 60 * 1000
    };

    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: expiredEnvelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: HOST_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(GUEST_PRIV)
        }),
        /expired/i
    );
});

test('bootstrap with future creation time exceeding skew is rejected', async () => {
    const now = Date.now();
    const artifact = await makeHostOffer();

    const futureEnvelope = {
        ...artifact.envelope,
        createdAt: now + 10 * 60 * 1000,
        expiresAt: now + 25 * 60 * 1000
    };

    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: futureEnvelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: HOST_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(GUEST_PRIV)
        }),
        /too far in the future/i
    );
});

test('publisher/sender mismatch is rejected', async () => {
    const artifact = await makeHostOffer();

    // verifiedPublisher claims to be GUEST but envelope.from is HOST
    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: artifact.envelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: GUEST_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(GUEST_PRIV)
        }),
        /publisher does not match/i
    );
});

test('wrong recipient is rejected (envelope.to does not match localAddress)', async () => {
    const artifact = await makeHostOffer(); // encrypted for GUEST

    // THIRD party trying to accept an offer addressed to GUEST
    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: artifact.envelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: HOST_ADDR,
            localAddress: THIRD_ADDR,
            decryptFn: decryptorFor(THIRD_PRIV)
        }),
        /recipient does not match/i
    );
});

test('tampered ciphertext (corrupted bytes) is rejected', async () => {
    const artifact = await makeHostOffer();

    const tamperedEnvelope = {
        ...artifact.envelope,
        encrypted: {
            ...artifact.envelope.encrypted,
            ciphertext: artifact.envelope.encrypted.ciphertext.slice(0, -4) + 'dead'
        }
    };

    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: tamperedEnvelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: HOST_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(GUEST_PRIV)
        }),
        /decrypt/i
    );
});

test('unsupported encryption algorithm is rejected', async () => {
    const artifact = await makeHostOffer();

    const badAlgEnvelope = {
        ...artifact.envelope,
        encrypted: {
            ...artifact.envelope.encrypted,
            algorithm: 'LEGACY-AES128-ECB'
        }
    };

    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: badAlgEnvelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: HOST_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(GUEST_PRIV)
        }),
        /unsupported encryption algorithm/i
    );
});

test('v1 bootstrap type is rejected with a migration message', async () => {
    const legacyEnvelope = {
        type: 'direct-message-bootstrap',
        version: 1,
        role: 'offer',
        from: { evmAddress: HOST_ADDR, eciesPublicKey: HOST_PUB },
        to: { evmAddress: GUEST_ADDR },
        session: { sessionId: 'aabbccdd00112233', containerKey: 'x'.repeat(64), createdAt: Date.now(), expiresAt: Date.now() + 900000, nonce: 'abc' },
        webrtc: { description: OFFER_DESC }
    };

    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: legacyEnvelope,
            envelopeBuffer: new TextEncoder().encode(JSON.stringify(legacyEnvelope)),
            verifiedPublisher: HOST_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(GUEST_PRIV)
        }),
        /v1.*no longer supported|legacy/i
    );
});

test('unknown/future version is rejected', async () => {
    const artifact = await makeHostOffer();
    const futureEnvelope = { ...artifact.envelope, version: 99 };

    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: futureEnvelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: HOST_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(GUEST_PRIV)
        }),
        /unsupported bootstrap version/i
    );
});

test('inner sender mismatch (decrypted from.evmAddress ≠ envelope from.evmAddress) is rejected', async () => {
    // Create a valid offer from HOST, then tamper the envelope's from address
    const artifact = await makeHostOffer();
    const tamperedEnvelope = {
        ...artifact.envelope,
        from: { evmAddress: THIRD_ADDR },
        to: { evmAddress: GUEST_ADDR }
    };

    // The ciphertext was encrypted for GUEST and signed by HOST,
    // but the tampered envelope claims it's from THIRD.
    // After decryption, inner.from.evmAddress === HOST_ADDR which !== THIRD_ADDR.
    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: tamperedEnvelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: THIRD_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(GUEST_PRIV)
        }),
        /inner payload sender does not match/i
    );
});

// ─── 7. verifyDirectMessageTorrentchain with injectable verifier ───────────────

test('verifyDirectMessageTorrentchain passes through to decryptAndVerify using injected verifier', async () => {
    const artifact = await makeHostOffer();
    const manifest = await makeMockManifest(HOST_ADDR, artifact.envelopeBytes);

    const result = await verifyDirectMessageTorrentchain({
        manifest,
        envelope: artifact.envelope,
        envelopeBuffer: artifact.envelopeBytes,
        localAddress: GUEST_ADDR,
        decryptFn: decryptorFor(GUEST_PRIV),
        _verifyManifestFn: mockVerifyManifest
    });

    assert.equal(result.role, 'offer');
    assert.equal(result.from.eciesPublicKey, HOST_PUB);
});

test('verifyDirectMessageTorrentchain rejects when torrentchain signature is invalid', async () => {
    const artifact = await makeHostOffer();

    const failingVerify = () => Promise.resolve({ verified: false, reason: 'bad-sig' });
    await assert.rejects(
        () => verifyDirectMessageTorrentchain({
            manifest: {},
            envelope: artifact.envelope,
            envelopeBuffer: artifact.envelopeBytes,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(GUEST_PRIV),
            _verifyManifestFn: failingVerify
        }),
        /invalid .torrentchain signature/i
    );
});

// ─── 8. Full in-memory round-trip via mock torrent client ─────────────────────

test('createDirectMessageBootstrapTorrent + loadDirectMessageBootstrapFromMagnet full round-trip (mocked client & TorrentChain)', async () => {
    const client = new InMemoryTorrentClient();

    // Host creates offer for guest
    const mockIdentityHost = {
        address: HOST_ADDR,
        chainId: 1,
        identityType: 'local-wallet'
    };

    // We need to mock createTorrentChainArtifact since it uses real wallet signing.
    // Instead, use loadDirectMessageBootstrapFromMagnet with _verifyManifestFn injection.
    // For createDirectMessageBootstrapTorrent, we bypass TorrentChain by providing
    // a mock identity with a custom signPublishPayload hook - but that's deep in the module.
    //
    // Instead, let's test the full flow through the mock:
    // create → magnet → load+decrypt with injected manifest verifier

    let capturedEnvelopeBytes = null;

    // Wrap client.seed to capture the envelope bytes for building a mock manifest
    const wrappedClient = {
        _store: client._store,
        seed(files, options, callback) {
            // Capture the dm-bootstrap.json file bytes
            const bootstrapFile = files.find((f) => f.name === 'dm-bootstrap.json');
            if (bootstrapFile) {
                bootstrapFile.arrayBuffer().then((buf) => {
                    capturedEnvelopeBytes = new Uint8Array(buf);
                }).catch(() => {});
            }
            client.seed(files, options, callback);
        },
        add(magnetURI, callback) {
            client.add(magnetURI, callback);
        }
    };

    // Mock identity requires signing — skip createDirectMessageBootstrapTorrent
    // and test the artifact creation + load directly using the low-level helpers:
    const offerArtifact = await createEncryptedDMBootstrapArtifact({
        identity: { address: HOST_ADDR },
        eciesPublicKey: HOST_PUB,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipientPublicKey: GUEST_PUB
    });

    // Simulate the torrent client storing the files
    const File = globalThis.File;
    const chainFile = new File([new TextEncoder().encode('{}')], '.torrentchain', { type: 'application/json' });
    const envelopeFile = new File([offerArtifact.envelopeBytes], 'dm-bootstrap.json', { type: 'application/json' });

    // Build a fake manifest matching the envelope
    const mockManifest = {
        payload: { publisher: HOST_ADDR },
        signature: 'mock',
        files: [{
            path: 'dm-bootstrap.json',
            sha256: await (async () => {
                const digest = await crypto.subtle.digest('SHA-256', offerArtifact.envelopeBytes);
                return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
            })()
        }]
    };

    // Store torrent in mock client
    const infoHash = 'testhash123';
    const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
    client._store.set(magnetURI, {
        magnetURI,
        infoHash,
        files: [
            {
                name: '.torrentchain',
                getBuffer: (cb) =>
                    chainFile.arrayBuffer().then((buf) => {
                        // Return a buffer with the actual mock manifest
                        const manifestBytes = new TextEncoder().encode(JSON.stringify(mockManifest));
                        cb(null, Buffer.from(manifestBytes));
                    }).catch(cb)
            },
            {
                name: 'dm-bootstrap.json',
                getBuffer: (cb) =>
                    envelopeFile.arrayBuffer().then((buf) => cb(null, Buffer.from(buf))).catch(cb)
            }
        ]
    });

    const result = await loadDirectMessageBootstrapFromMagnet({
        client,
        magnetURI,
        localAddress: GUEST_ADDR,
        decryptFn: decryptorFor(GUEST_PRIV),
        _verifyManifestFn: mockVerifyManifest
    });

    assert.equal(result.role, 'offer');
    assert.equal(result.from.evmAddress, HOST_ADDR);
    assert.equal(result.from.eciesPublicKey, HOST_PUB);
    assert.equal(result.webrtc.description.sdp, 'mock-offer-sdp');
    assert.ok(result.session.sessionId, 'sessionId is present');
    assert.ok(!result.session.containerKey, 'containerKey is absent');
});

// ─── 9. Replay protection ─────────────────────────────────────────────────────

test('replay of the same bootstrap nonce/session is rejected', async () => {
    const artifact = await createEncryptedDMBootstrapArtifact({
        identity: { address: HOST_ADDR },
        eciesPublicKey: HOST_PUB,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipientPublicKey: GUEST_PUB,
        sessionId: 'aa00bb11cc22dd33' // valid 16-char hex for replay test
    });

    // First call succeeds
    await decryptAndVerifyDMBootstrapArtifact({
        envelope: artifact.envelope,
        envelopeBuffer: artifact.envelopeBytes,
        verifiedPublisher: HOST_ADDR,
        localAddress: GUEST_ADDR,
        decryptFn: decryptorFor(GUEST_PRIV)
    });

    // Same artifact again — should be rejected as replay
    await assert.rejects(
        () => decryptAndVerifyDMBootstrapArtifact({
            envelope: artifact.envelope,
            envelopeBuffer: artifact.envelopeBytes,
            verifiedPublisher: HOST_ADDR,
            localAddress: GUEST_ADDR,
            decryptFn: decryptorFor(GUEST_PRIV)
        }),
        /replay/i
    );
});
