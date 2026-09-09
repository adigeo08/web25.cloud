/**
 * `.torrentchain` as the signed source of truth.
 *
 * The manifest is the only thing a viewer trusts, so what these tests pin is
 * coverage: the owner block, the file list, the protected assets and every
 * grant are inside the signed payload, and a manifest edited anywhere fails
 * verification rather than rendering with an attacker's access rules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as ecies from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';
import {
    canonicalizeOwner,
    canonicalTorrentChainMessage,
    createTorrentChainArtifact,
    hashFileEntries,
    verifyTorrentChainManifest
} from '../src/torrent/TorrentChainProtocol.js';
import { newUuid, TORRENTCHAIN_SCHEMA } from '../src/torrent/ProtectedAssetProtocol.js';
import { buildProtectedSite, prepareProtectionWorkspace } from '../src/torrent/ProtectedSiteBuilder.js';
import { textContentOf } from '../src/torrent/AuthoringDom.js';
import { canonicalJson } from '../src/torrent/CanonicalJson.js';

const OWNER_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const GUEST_KEY = '0x2222222222222222222222222222222222222222222222222222222222222222';
const OWNER_PUB = ecies.getPublicKeyFromPrivateKey(OWNER_KEY);
const GUEST_PUB = ecies.getPublicKeyFromPrivateKey(GUEST_KEY);
const OWNER_ADDRESS = ecies.evmAddressFromPublicKey(OWNER_PUB);
const OWNER_NOSTR = nostrCore.getNostrPublicKey(OWNER_KEY);
const OWNER_NPUB = npubEncode(OWNER_NOSTR);

const OWNER = {
    evmAddress: OWNER_ADDRESS,
    eciesPublicKey: OWNER_PUB,
    nostrPublicKey: OWNER_NOSTR,
    npub: OWNER_NPUB
};

const SITE_HTML = '<html><body><p>Free part. <b>Paid part</b> here.</p></body></html>';

const ECIES_HANDLE = {
    eciesEncrypt: ecies.eciesEncrypt,
    evmAddressFromPublicKey: ecies.evmAddressFromPublicKey,
    isValidUncompressedPublicKey: ecies.isValidUncompressedPublicKey
};

/**
 * A signer that records what it was asked to sign. The signature itself is a
 * digest of the message, so "the signature covers X" is testable without the
 * wallet worker or a network round trip.
 */
function recordingSigner() {
    const signed = [];
    const sign = async (payload, _identityType, message) => {
        signed.push(message);
        return { payload, message, signature: `sig:${message.length}:${simpleDigest(message)}` };
    };
    const verify = async (message, signature) => signature === `sig:${message.length}:${simpleDigest(message)}`;
    return { signed, sign, verify };
}

function simpleDigest(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }
    return hash.toString(16);
}

function virtualFile(path, text) {
    const bytes = new TextEncoder().encode(text);
    return {
        name: path.split('/').pop(),
        webkitRelativePath: path,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
}

/** Build a real protected site, then a manifest over it. */
async function signedProtectedSite({ protect = true } = {}) {
    const files = [{ path: 'index.html', contentType: 'text/html', bytes: new TextEncoder().encode(SITE_HTML) }];

    let selections = [];
    if (protect) {
        const document_ = prepareProtectionWorkspace(files).get('index.html');
        let containerId = null;
        for (const [id, element] of document_.previewIndex) {
            if (element.tag === 'p') containerId = id;
        }
        const text = textContentOf(document_.previewIndex.get(containerId));
        const startOffset = text.indexOf('Paid part');
        selections = [
            {
                locator: {
                    path: 'index.html',
                    containerId,
                    startOffset,
                    endOffset: startOffset + 'Paid part'.length,
                    exact: 'Paid part',
                    prefix: text.slice(0, startOffset),
                    suffix: text.slice(startOffset + 'Paid part'.length)
                },
                recipientPublicKeys: [GUEST_PUB]
            }
        ];
    }

    const built = await buildProtectedSite({ files, selections, owner: { eciesPublicKey: OWNER_PUB }, ecies: ECIES_HANDLE });
    const signer = recordingSigner();
    const artifact = await createTorrentChainArtifact({
        inMemoryFiles: built.files.map((file) => virtualFile(file.path, new TextDecoder().decode(file.bytes))),
        publisher: OWNER_ADDRESS,
        chainId: 1,
        identityType: 'local-wallet',
        createdAt: '2026-01-01T00:00:00.000Z',
        siteId: built.siteId,
        owner: OWNER,
        protectedAssets: built.protectedAssets,
        _signPayloadFn: signer.sign
    });

    return { built, artifact, signer, verify: (manifest) => verifyTorrentChainManifest(manifest, { _verifySignatureFn: signer.verify }) };
}

// ─── the schema stays v1 ─────────────────────────────────────────────────

test('the manifest schema is still web25-torrentchain-v1', async () => {
    const { artifact } = await signedProtectedSite();
    assert.equal(artifact.manifest.schema, 'web25-torrentchain-v1');
    assert.equal(artifact.payload.schema, TORRENTCHAIN_SCHEMA);
});

// ─── the owner block ─────────────────────────────────────────────────────

test('the owner block records all four views of the publisher key', async () => {
    const { artifact } = await signedProtectedSite();
    assert.deepEqual(artifact.payload.owner, {
        evmAddress: OWNER_ADDRESS.toLowerCase(),
        eciesPublicKey: OWNER_PUB.toLowerCase(),
        nostrPublicKey: OWNER_NOSTR,
        npub: OWNER_NPUB
    });
});

test('an owner that is not the signing publisher is refused at creation', async () => {
    const signer = recordingSigner();
    await assert.rejects(
        createTorrentChainArtifact({
            inMemoryFiles: [virtualFile('index.html', SITE_HTML)],
            publisher: '0x' + 'ab'.repeat(20),
            chainId: 1,
            identityType: 'local-wallet',
            createdAt: '2026-01-01T00:00:00.000Z',
            siteId: newUuid(),
            owner: OWNER,
            _signPayloadFn: signer.sign
        }),
        /owner must be the publisher/
    );
});

test('an owner block with unusable key material is refused', () => {
    assert.throws(() => canonicalizeOwner({ ...OWNER, eciesPublicKey: OWNER_ADDRESS }), /not encryption material/);
    assert.throws(() => canonicalizeOwner({ ...OWNER, eciesPublicKey: `04${'11'.repeat(64)}` }), /not a valid point/);
    assert.throws(() => canonicalizeOwner({ ...OWNER, evmAddress: 'nope' }), /evmAddress/);
    assert.throws(() => canonicalizeOwner({ ...OWNER, nostrPublicKey: 'zz' }), /nostrPublicKey/);
    assert.throws(() => canonicalizeOwner({ ...OWNER, npub: 'npub-not-bech32' }), /npub/);

    // A publisher with no Nostr identity yet is allowed: the fields are empty,
    // not invented.
    assert.deepEqual(canonicalizeOwner({ evmAddress: OWNER_ADDRESS, eciesPublicKey: OWNER_PUB }), {
        evmAddress: OWNER_ADDRESS.toLowerCase(),
        eciesPublicKey: OWNER_PUB.toLowerCase(),
        nostrPublicKey: '',
        npub: ''
    });
});

// ─── what the signature covers ───────────────────────────────────────────

test('the signed message covers owner, files, protected assets and grants', async () => {
    const { artifact, signer } = await signedProtectedSite();
    assert.equal(signer.signed.length, 1);
    const message = signer.signed[0];

    assert.ok(message.includes(OWNER_PUB.toLowerCase()), 'owner key');
    assert.ok(message.includes(artifact.payload.filesHash), 'file list digest');
    assert.ok(message.includes(artifact.payload.protectedAssets[0].assetId), 'protected asset');
    assert.ok(message.includes(artifact.payload.protectedAssets[0].cipherHash), 'ciphertext digest');
    assert.ok(message.includes(artifact.payload.protectedAssets[0].grants[0].grantHash), 'grant digest');
    assert.ok(message.includes(artifact.payload.protectedAssets[0].grants[0].wrappedKey), 'wrapped key');
    assert.equal(message, canonicalTorrentChainMessage(artifact.payload));
});

test('the signed message is canonical: field order never changes it', () => {
    const payload = { b: 2, a: [3, { z: 1, y: 2 }], c: { n: null } };
    const shuffled = { c: { n: null }, a: [3, { y: 2, z: 1 }], b: 2 };
    assert.equal(canonicalTorrentChainMessage(payload), canonicalTorrentChainMessage(shuffled));
});

test('protected assets and grants are sorted deterministically before signing', async () => {
    const files = [{ path: 'index.html', contentType: 'text/html', bytes: new TextEncoder().encode(SITE_HTML) }];
    const document_ = prepareProtectionWorkspace(files).get('index.html');
    let containerId = null;
    for (const [id, element] of document_.previewIndex) if (element.tag === 'p') containerId = id;
    const text = textContentOf(document_.previewIndex.get(containerId));
    const start = text.indexOf('Paid part');

    const built = await buildProtectedSite({
        files,
        selections: [
            {
                locator: {
                    path: 'index.html',
                    containerId,
                    startOffset: start,
                    endOffset: start + 9,
                    exact: 'Paid part',
                    prefix: text.slice(0, start),
                    suffix: text.slice(start + 9)
                },
                // Deliberately out of order.
                recipientPublicKeys: [GUEST_PUB, OWNER_PUB]
            }
        ],
        owner: { eciesPublicKey: OWNER_PUB },
        ecies: ECIES_HANDLE
    });

    const keys = built.protectedAssets[0].grants.map((grant) => grant.recipientPublicKey);
    assert.deepEqual(keys, [...keys].sort(), 'grants are ordered by recipient key');
    assert.equal(new Set(keys).size, keys.length, 'the owner is not duplicated by also being invited');
});

// ─── verification ────────────────────────────────────────────────────────

test('a well-formed manifest verifies and hands back owner, siteId and assets', async () => {
    const { artifact, built, verify } = await signedProtectedSite();
    const result = await verify(artifact.manifest);

    assert.equal(result.verified, true, result.reason);
    assert.equal(result.publisher, OWNER_ADDRESS);
    assert.equal(result.siteId, built.siteId);
    assert.equal(result.owner.npub, OWNER_NPUB);
    assert.equal(result.protectedAssets.length, 1);
});

test('a manifest edited anywhere fails verification', async () => {
    const { artifact, verify } = await signedProtectedSite();
    const clone = () => JSON.parse(JSON.stringify(artifact.manifest));

    const addedGrant = clone();
    addedGrant.payload.protectedAssets[0].grants.push({
        ...addedGrant.payload.protectedAssets[0].grants[0],
        recipientPublicKey: GUEST_PUB.toLowerCase()
    });
    assert.equal((await verify(addedGrant)).verified, false, 'a grant appended to the payload');

    const swappedOwner = clone();
    swappedOwner.payload.owner.eciesPublicKey = GUEST_PUB.toLowerCase();
    assert.equal((await verify(swappedOwner)).verified, false, 'a different owner key');

    const editedCipherHash = clone();
    editedCipherHash.payload.protectedAssets[0].cipherHash = 'f'.repeat(64);
    assert.equal((await verify(editedCipherHash)).verified, false, 'a different ciphertext digest');

    const editedFiles = clone();
    editedFiles.files[0].sha256 = 'f'.repeat(64);
    const filesResult = await verify(editedFiles);
    assert.equal(filesResult.verified, false, 'an edited file list');
    assert.match(filesResult.reason, /filesHash/);

    const droppedFiles = clone();
    delete droppedFiles.files;
    assert.match((await verify(droppedFiles)).reason, /missing the file list/);

    const foreignMessage = clone();
    foreignMessage.message = canonicalTorrentChainMessage({ ...artifact.payload, publisher: '0x' + '00'.repeat(20) });
    const messageResult = await verify(foreignMessage);
    assert.equal(messageResult.verified, false, 'a message that does not match its own payload');
    assert.match(messageResult.reason, /does not match the manifest payload/);
});

test('a manifest whose signature does not recover to the publisher is refused', async () => {
    const { artifact } = await signedProtectedSite();
    const result = await verifyTorrentChainManifest(artifact.manifest, { _verifySignatureFn: async () => false });
    assert.equal(result.verified, false);
    assert.match(result.reason, /does not recover to the publisher/);
});

test('an unsupported schema is refused before anything else is looked at', async () => {
    const { artifact, verify } = await signedProtectedSite();
    const wrongSchema = JSON.parse(JSON.stringify(artifact.manifest));
    wrongSchema.payload.schema = 'web25-torrentchain-v2';
    const result = await verify(wrongSchema);
    assert.equal(result.verified, false);
    assert.match(result.reason, /Unsupported .torrentchain schema/);
});

test('protected assets without a siteId are refused', async () => {
    const { artifact } = await signedProtectedSite();
    const noSite = JSON.parse(JSON.stringify(artifact.manifest));
    delete noSite.payload.siteId;
    // Drop the message too, so the payload/message check does not catch this
    // first: what is under test is the siteId requirement itself.
    delete noSite.message;

    const result = await verifyTorrentChainManifest(noSite, { _verifySignatureFn: async () => true });
    assert.equal(result.verified, false);
    assert.match(result.reason, /siteId/);
});

// ─── a site that protects nothing ────────────────────────────────────────

test('a manifest with no protected assets verifies and reports an empty list', async () => {
    const { artifact, verify } = await signedProtectedSite({ protect: false });

    assert.deepEqual(artifact.payload.protectedAssets, []);
    const result = await verify(artifact.manifest);
    assert.equal(result.verified, true, result.reason);
    assert.deepEqual(result.protectedAssets, []);
    assert.equal(result.owner.evmAddress, OWNER_ADDRESS.toLowerCase());
});

// ─── the file list digest ────────────────────────────────────────────────

test('filesHash covers paths and sizes, not just content digests', async () => {
    const entries = [
        { path: 'index.html', size: 12, sha256: 'a'.repeat(64) },
        { path: 'app.js', size: 3, sha256: 'b'.repeat(64) }
    ];
    const baseline = await hashFileEntries(entries);

    assert.equal(await hashFileEntries([...entries].reverse()), baseline, 'input order does not matter');
    assert.notEqual(await hashFileEntries([{ ...entries[0], path: 'other.html' }, entries[1]]), baseline);
    assert.notEqual(await hashFileEntries([{ ...entries[0], size: 13 }, entries[1]]), baseline);
    assert.notEqual(await hashFileEntries([entries[1]]), baseline);
});

test('the ciphertext files are part of the signed file list', async () => {
    const { artifact, built } = await signedProtectedSite();
    const cipherPath = built.protectedAssets[0].cipherPath;
    assert.ok(
        artifact.manifest.files.some((entry) => entry.path === cipherPath),
        'the ciphertext is hashed into the manifest like any other bundle file'
    );
    assert.equal(artifact.payload.filesHash, await hashFileEntries(artifact.manifest.files));
});

test('the manifest never carries the plaintext it protects', async () => {
    const { artifact } = await signedProtectedSite();
    const serialized = canonicalJson(artifact.payload);
    assert.ok(!serialized.includes('Paid part'), 'the protected text');
    assert.ok(!serialized.includes('Free part'), 'nor the text around it');
    assert.ok(!/"cek"/.test(serialized), 'nor a content key');
});
