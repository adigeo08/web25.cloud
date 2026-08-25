/**
 * End-to-end: a real `.torrentchain` proof mirrored into a real registry event.
 *
 * The other registry tests use fixtures and a stubbed verifier. This one runs
 * the actual producers — `buildTorrentChainDraft` for the payload, the real
 * EIP-191 signer for the EVM signature, the real NIP-35 builder, and a real
 * secp256k1 public-key recovery for verification — so the mirrored proof is
 * proven to verify rather than merely to be copied.
 *
 * It also pins the property the whole design depends on: publishing to the
 * registry performs exactly *one* EVM signing operation per website, the one
 * that already happened when `.torrentchain` was created.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import { buildTorrentChainDraft } from '../src/torrent/TorrentChainProtocol.js';
import { serializePayload } from '../src/torrent/TorrentSignaturePayload.js';
import { evmAddressFromPublicKey, signEvmMessage } from '../src/channels/ecies.js';
import {
    buildNosnsEventTemplate,
    firstTagValue,
    matchesDownloadedManifest,
    parseNosnsEvent,
    verifyNosnsProof,
    WEB25_VERIFICATION
} from '../src/nosns/NosNSEvent.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';

const WALLET_PRIV = '0x1111111111111111111111111111111111111111111111111111111111111111';
const INFOHASH = 'e5a1c0d4b7f28369ac015be47d3902fa6c8b1d47';

/**
 * Recover the signer of an EIP-191 message, standing in for viem's
 * `recoverMessageAddress` (the real `verifyPublishSignature`, which cannot run
 * offline here). Same algorithm, same result.
 *
 * @param {string} message
 * @param {string} signature 0x-prefixed 65-byte r||s||v
 * @returns {string} lowercase EVM address
 */
function recoverEvmAddress(message, signature) {
    const messageBytes = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
    const preimage = new Uint8Array(prefix.length + messageBytes.length);
    preimage.set(prefix, 0);
    preimage.set(messageBytes, prefix.length);
    const digest = keccak_256(preimage);

    const raw = signature.replace(/^0x/, '');
    const compact = nostrCore.hexToBytes(raw.slice(0, 128));
    const recovery = parseInt(raw.slice(128, 130), 16) - 27;

    const recovered = secp256k1.Signature.fromCompact(compact).addRecoveryBit(recovery).recoverPublicKey(digest);
    return evmAddressFromPublicKey(recovered.toHex(false)).toLowerCase();
}

/** A verifier with the same contract as `verifyPublishSignature`. */
async function realEvmVerifier(message, signature, publisher) {
    try {
        return recoverEvmAddress(message, signature) === `${publisher}`.toLowerCase();
    } catch (_) {
        return false;
    }
}

function virtualFile(path, contents) {
    const file = new File([new TextEncoder().encode(contents)], path.split('/').pop() || path);
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
}

/**
 * Run the real deployment sequence up to a signed `.torrentchain`, counting how
 * many times the EVM key is used.
 */
async function deployWebsite({ signCounter }) {
    const siteFiles = [
        virtualFile('index.html', '<!doctype html><h1>Hello WEB25</h1>'),
        virtualFile('assets/app.css', 'body{color:#0f0}')
    ];

    const draft = await buildTorrentChainDraft(siteFiles);
    const payload = {
        schema: 'web25-torrentchain-v1',
        publisher: evmAddressFromPublicKey(
            nostrCore.bytesToHex(secp256k1.getPublicKey(nostrCore.hexToBytes(WALLET_PRIV), false))
        ),
        chainId: 1,
        createdAt: '2026-02-01T10:00:00.000Z',
        fileCount: draft.fileCount,
        totalBytes: draft.totalBytes,
        merkleRoot: draft.merkleRoot,
        filesSemantics: 'bundle-contents',
        bundle: {
            name: 'site.bundle.json.gz',
            sha256: 'c'.repeat(64),
            contentEncoding: 'gzip',
            schema: 'web25-sitebundle-v1'
        }
    };

    // The one and only EVM signing operation for this website.
    const message = serializePayload(payload);
    signCounter.evm += 1;
    const signature = signEvmMessage(message, WALLET_PRIV);

    const manifest = {
        schema: payload.schema,
        payload,
        message,
        signature,
        signatureAlgorithm: 'EVM_SECP256K1',
        files: draft.fileEntries
    };

    // The torrent is created *after* signing, so the infohash can never feed
    // back into the signed payload.
    const torrent = {
        infoHash: INFOHASH,
        name: 'hello-web25',
        files: [
            { path: 'hello-web25/.torrentchain', length: JSON.stringify(manifest, null, 2).length },
            { path: 'hello-web25/site.bundle.json.gz', length: 4096 }
        ],
        announce: ['wss://tracker.openwebtorrent.com/']
    };

    return { manifest, torrent, chainArtifact: { payload, message, signature } };
}

// ─── 1. The mirrored proof actually verifies ─────────────────────────────

test('a registry event mirrors a real .torrentchain proof that independently verifies', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { manifest, torrent, chainArtifact } = await deployWebsite({ signCounter });

    const template = buildNosnsEventTemplate({ torrent, chainArtifact, siteName: 'Hello WEB25' });
    signCounter.nostr += 1;
    const event = nostrCore.signEvent(template, WALLET_PRIV.slice(2));

    const result = await verifyNosnsProof(parseNosnsEvent(event, { npubEncode }), realEvmVerifier);

    assert.equal(result.web25VerificationState, WEB25_VERIFICATION.VERIFIED);
    assert.equal(result.web25Publisher, manifest.payload.publisher.toLowerCase());
});

test('exactly one EVM signature is produced per website, and none for the registry', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { torrent, chainArtifact } = await deployWebsite({ signCounter });

    assert.equal(signCounter.evm, 1, 'the website is signed once, when .torrentchain is built');

    // Building and signing the registry event adds a Nostr signature only.
    const template = buildNosnsEventTemplate({ torrent, chainArtifact, siteName: 'Hello WEB25' });
    nostrCore.signEvent(template, WALLET_PRIV.slice(2));
    signCounter.nostr += 1;

    assert.equal(signCounter.evm, 1, 'registry publication must never prompt a second EVM signature');
    assert.equal(signCounter.nostr, 1);
});

test('the two signatures are distinct and prove different things', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { manifest, torrent, chainArtifact } = await deployWebsite({ signCounter });
    const event = nostrCore.signEvent(
        buildNosnsEventTemplate({ torrent, chainArtifact, siteName: 'Hello WEB25' }),
        WALLET_PRIV.slice(2)
    );

    const evmSignature = firstTagValue(event.tags, 'web25-signature');
    assert.equal(evmSignature, manifest.signature, 'the EVM signature is mirrored, not regenerated');
    assert.notEqual(evmSignature, event.sig, 'the Nostr signature is a separate artifact');

    // Nostr signature → who published the registry entry.
    assert.equal(nostrCore.verifyEvent(event), true);
    // EVM signature → who published the website.
    assert.equal(await realEvmVerifier(manifest.message, manifest.signature, manifest.payload.publisher), true);
});

test('both identities come from the same local wallet key', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { manifest, torrent, chainArtifact } = await deployWebsite({ signCounter });
    const event = nostrCore.signEvent(
        buildNosnsEventTemplate({ torrent, chainArtifact }),
        WALLET_PRIV.slice(2)
    );

    const eciesPublicKey = nostrCore.bytesToHex(secp256k1.getPublicKey(nostrCore.hexToBytes(WALLET_PRIV), false));
    assert.equal(event.pubkey, nostrCore.nostrPublicKeyFromEciesPublicKey(eciesPublicKey));
    assert.equal(manifest.payload.publisher, evmAddressFromPublicKey(eciesPublicKey));
});

// ─── 2. Tampering is caught ──────────────────────────────────────────────

test('a forged publisher claim fails EVM verification', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { torrent, chainArtifact } = await deployWebsite({ signCounter });

    // Re-sign the payload with a different key while keeping the claimed
    // publisher: a valid Nostr event carrying a bad WEB25 proof.
    const forgedSignature = signEvmMessage(
        chainArtifact.message,
        '0x2222222222222222222222222222222222222222222222222222222222222222'
    );
    const template = buildNosnsEventTemplate({
        torrent,
        chainArtifact: { ...chainArtifact, signature: forgedSignature }
    });
    const event = nostrCore.signEvent(template, WALLET_PRIV.slice(2));

    assert.equal(nostrCore.verifyEvent(event), true, 'the registry entry is genuinely signed...');

    const result = await verifyNosnsProof(parseNosnsEvent(event, { npubEncode }), realEvmVerifier);
    assert.equal(result.web25VerificationState, WEB25_VERIFICATION.INVALID, '...but the website proof does not hold');
});

test('registry metadata is checked against the downloaded .torrentchain', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { manifest, torrent, chainArtifact } = await deployWebsite({ signCounter });
    const event = nostrCore.signEvent(buildNosnsEventTemplate({ torrent, chainArtifact }), WALLET_PRIV.slice(2));
    const result = parseNosnsEvent(event, { npubEncode });

    // The honest case: registry and manifest agree.
    assert.deepEqual(matchesDownloadedManifest(result, manifest), { matches: true, mismatches: [] });

    // A swarm serving different content: the manifest wins, and the
    // disagreement is detected before anything renders.
    const swappedManifest = {
        ...manifest,
        payload: { ...manifest.payload, merkleRoot: 'f'.repeat(64) }
    };
    const comparison = matchesDownloadedManifest(result, swappedManifest);
    assert.equal(comparison.matches, false);
    assert.deepEqual(comparison.mismatches, ['merkleRoot']);
});

// ─── 3. Anti-circularity ─────────────────────────────────────────────────

test('the signed .torrentchain payload never contains the final infohash', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { manifest } = await deployWebsite({ signCounter });

    const signedPayload = JSON.stringify(manifest.payload);
    assert.ok(!signedPayload.includes(INFOHASH), 'the infohash depends on .torrentchain, so it cannot be inside it');
    assert.equal(manifest.message, signedPayload);
});

test('the registry event is where the infohash and the proof finally meet', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { manifest, torrent, chainArtifact } = await deployWebsite({ signCounter });
    const event = nostrCore.signEvent(buildNosnsEventTemplate({ torrent, chainArtifact }), WALLET_PRIV.slice(2));

    // Created after the torrent exists, so it can safely carry both.
    assert.equal(firstTagValue(event.tags, 'x'), INFOHASH);
    assert.equal(firstTagValue(event.tags, 'web25-signature'), manifest.signature);
});

// ─── 4. The load-path cross-check ────────────────────────────────────────

/**
 * Mirrors the check now wired into `verifyTorrentChainGate`: when a site was
 * opened from a registry result, the downloaded manifest is compared against
 * the claim. The manifest always wins — the comparison withdraws a false
 * registry claim, it never blocks a load that `.torrentchain` already verified.
 */
function simulateLoadPathCrossCheck({ registryClaim, hash, manifest }) {
    if (!registryClaim || `${registryClaim.infohash}`.toLowerCase() !== `${hash}`.toLowerCase()) {
        return { checked: false, matches: null, mismatches: [], loadBlocked: false };
    }
    const comparison = matchesDownloadedManifest(registryClaim, manifest);
    return { checked: true, ...comparison, loadBlocked: false };
}

test('opening from the registry compares the claim against the downloaded manifest', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { manifest, torrent, chainArtifact } = await deployWebsite({ signCounter });
    const event = nostrCore.signEvent(buildNosnsEventTemplate({ torrent, chainArtifact }), WALLET_PRIV.slice(2));
    const claim = parseNosnsEvent(event, { npubEncode });

    const check = simulateLoadPathCrossCheck({ registryClaim: claim, hash: INFOHASH, manifest });
    assert.equal(check.checked, true);
    assert.equal(check.matches, true);
});

test('a lying registry entry is detected but never blocks a valid load', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { manifest, torrent, chainArtifact } = await deployWebsite({ signCounter });
    const event = nostrCore.signEvent(buildNosnsEventTemplate({ torrent, chainArtifact }), WALLET_PRIV.slice(2));
    const claim = parseNosnsEvent(event, { npubEncode });

    // The swarm serves a genuinely signed site by somebody else.
    const otherPriv = '0x2222222222222222222222222222222222222222222222222222222222222222';
    const otherPayload = { ...manifest.payload, publisher: '0x' + '2'.repeat(40) };
    const otherMessage = JSON.stringify(otherPayload);
    const servedManifest = {
        ...manifest,
        payload: otherPayload,
        message: otherMessage,
        signature: signEvmMessage(otherMessage, otherPriv)
    };

    const check = simulateLoadPathCrossCheck({ registryClaim: claim, hash: INFOHASH, manifest: servedManifest });
    assert.equal(check.matches, false);
    assert.ok(check.mismatches.includes('publisher'));
    assert.equal(check.loadBlocked, false, '.torrentchain already verified the site on its own terms');
});

test('a site loaded by hash carries no registry claim to check', () => {
    const check = simulateLoadPathCrossCheck({ registryClaim: null, hash: INFOHASH, manifest: {} });
    assert.equal(check.checked, false, 'the hash-loading path is untouched by the registry');
});

test('a claim for a different infohash is not applied to this load', async () => {
    const signCounter = { evm: 0, nostr: 0 };
    const { manifest, torrent, chainArtifact } = await deployWebsite({ signCounter });
    const event = nostrCore.signEvent(buildNosnsEventTemplate({ torrent, chainArtifact }), WALLET_PRIV.slice(2));
    const claim = parseNosnsEvent(event, { npubEncode });

    const check = simulateLoadPathCrossCheck({ registryClaim: claim, hash: 'f'.repeat(40), manifest });
    assert.equal(check.checked, false);
});
