/**
 * WEB25 website registry: NIP-35 event construction and the mirrored proof.
 *
 * The registry is discovery only. These tests pin what the event says, that it
 * mirrors the `.torrentchain` proof exactly rather than deriving a second one,
 * and that the two signatures involved stay distinct: a valid Nostr signature
 * never implies a verified WEB25 publisher.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildRegistryEventTemplate,
    describeTorrentArtifact,
    isWeb25RegistryEvent,
    matchesDownloadedManifest,
    parseRegistryEvent,
    verifyRegistryProof,
    WEB25_VERIFICATION,
    allTagValues,
    firstTagValue
} from '../src/registry/Web25RegistryEvent.js';
import { NOSTR_REGISTRY_CONFIG } from '../src/config/nostr.config.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';

const INFOHASH = 'e5a1c0d4b7f28369ac015be47d3902fa6c8b1d47';
const PUBLISHER = '0x1111111111111111111111111111111111111111';
const OTHER_PUBLISHER = '0x2222222222222222222222222222222222222222';
const EVM_SIGNATURE = `0x${'9'.repeat(130)}`;
const TRACKER = 'wss://tracker.openwebtorrent.com/';
const NOSTR_PRIV = '1111111111111111111111111111111111111111111111111111111111111111';

/** The torrent WEB25 actually creates in the default gzip mode. */
function gzipTorrent(overrides = {}) {
    return {
        infoHash: INFOHASH,
        name: 'my-site',
        files: [
            { path: 'my-site/.torrentchain', name: '.torrentchain', length: 1234 },
            { path: 'my-site/site.bundle.json.gz', name: 'site.bundle.json.gz', length: 56789 }
        ],
        announce: [TRACKER],
        ...overrides
    };
}

/** The torrent WEB25 creates when SITE_BUNDLE_MODE is `files`. */
function filesTorrent() {
    return {
        infoHash: INFOHASH,
        name: 'my-site',
        files: [
            { path: 'my-site/.torrentchain', name: '.torrentchain', length: 1234 },
            { path: 'my-site/index.html', name: 'index.html', length: 900 },
            { path: 'my-site/assets/app.css', name: 'app.css', length: 300 }
        ],
        announce: [TRACKER]
    };
}

/** A `.torrentchain` artifact exactly as `createTorrentChainArtifact` returns it. */
function chainArtifact(overrides = {}) {
    const payload = {
        schema: 'web25-torrentchain-v1',
        publisher: PUBLISHER,
        chainId: 1,
        createdAt: '2026-02-01T10:00:00.000Z',
        fileCount: 2,
        totalBytes: 1200,
        merkleRoot: 'a'.repeat(64),
        filesSemantics: 'bundle-contents',
        bundle: {
            name: 'site.bundle.json.gz',
            sha256: 'b'.repeat(64),
            contentEncoding: 'gzip',
            schema: 'web25-sitebundle-v1'
        },
        ...(overrides.payload || {})
    };
    return {
        payload,
        message: overrides.message ?? JSON.stringify(payload),
        signature: overrides.signature ?? EVM_SIGNATURE
    };
}

/** Build, then sign, so parsing runs against a genuinely signed event. */
function signRegistryEvent(template, privateKey = NOSTR_PRIV) {
    return nostrCore.signEvent(template, privateKey);
}

function buildSigned(params = {}) {
    return signRegistryEvent(
        buildRegistryEventTemplate({
            torrent: gzipTorrent(),
            chainArtifact: chainArtifact(),
            siteName: 'My Site',
            ...params
        })
    );
}

// ─── 1. Event construction ───────────────────────────────────────────────

test('the registry event is a NIP-35 kind 2003 torrent event', () => {
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: chainArtifact() });
    assert.equal(template.kind, 2003);
    assert.equal(NOSTR_REGISTRY_CONFIG.TORRENT_EVENT_KIND, 2003);
});

test('the event carries the final torrent infohash in the x tag', () => {
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: chainArtifact() });
    assert.equal(firstTagValue(template.tags, 'x'), INFOHASH);
});

test('the event carries exactly the WEB25 website category', () => {
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: chainArtifact() });
    assert.deepEqual(allTagValues(template.tags, 'i'), ['tcat:web25.cloud,websites']);
    assert.equal(NOSTR_REGISTRY_CONFIG.WEB25_CATEGORY, 'tcat:web25.cloud,websites');
});

test('the event carries the generic WEB25 hashtags', () => {
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: chainArtifact() });
    assert.deepEqual(allTagValues(template.tags, 't').sort(), ['static-site', 'web25', 'website']);
});

test('gzip mode advertises the actual torrent entries, not the bundled site files', () => {
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: chainArtifact() });
    const files = template.tags.filter((tag) => tag[0] === 'file');

    assert.deepEqual(files, [
        ['file', '.torrentchain', '1234'],
        ['file', 'site.bundle.json.gz', '56789']
    ]);
    // The site's own files live inside the compressed bundle and must not be
    // advertised as torrent entries.
    assert.ok(!files.some((tag) => tag[1] === 'index.html'));
});

test('files mode advertises the real per-file torrent layout', () => {
    const template = buildRegistryEventTemplate({ torrent: filesTorrent(), chainArtifact: chainArtifact() });
    const files = template.tags.filter((tag) => tag[0] === 'file');

    assert.deepEqual(files, [
        ['file', '.torrentchain', '1234'],
        ['file', 'index.html', '900'],
        ['file', 'assets/app.css', '300']
    ]);
});

test('the torrent name prefix is stripped from advertised file paths', () => {
    const artifact = describeTorrentArtifact(gzipTorrent());
    assert.deepEqual(artifact.files.map((file) => file.path), ['.torrentchain', 'site.bundle.json.gz']);
});

test('the actual tracker list is included', () => {
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: chainArtifact() });
    assert.deepEqual(allTagValues(template.tags, 'tracker'), [TRACKER]);
});

test('trackers fall back to the deployment configuration when the torrent has none', () => {
    const template = buildRegistryEventTemplate({
        torrent: gzipTorrent({ announce: [] }),
        chainArtifact: chainArtifact(),
        trackers: ['wss://tracker.example/']
    });
    assert.deepEqual(allTagValues(template.tags, 'tracker'), ['wss://tracker.example/']);
});

test('the title falls back to the torrent name', () => {
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: chainArtifact() });
    assert.equal(firstTagValue(template.tags, 'title'), 'my-site');
});

test('an unseeded torrent or a missing .torrentchain cannot produce an event', () => {
    assert.throws(() => buildRegistryEventTemplate({ torrent: { infoHash: 'nope' }, chainArtifact: chainArtifact() }), /infohash/i);
    assert.throws(
        () => buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: { payload: null, message: '', signature: '' } }),
        /signed .torrentchain artifact is required/i
    );
});

test('no private DM material can appear in a public registry event', () => {
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: chainArtifact() });
    const wire = JSON.stringify(template);

    for (const forbidden of ['sdp', 'candidate', 'ice', 'nsec', 'eciesPublicKey', 'nip44']) {
        assert.ok(!wire.toLowerCase().includes(forbidden), `a registry event must not mention ${forbidden}`);
    }
});

// ─── 2. Mirroring the .torrentchain proof ────────────────────────────────

test('the registry mirrors the .torrentchain proof field for field', () => {
    const artifact = chainArtifact();
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: artifact });

    assert.equal(firstTagValue(template.tags, 'web25-publisher'), artifact.payload.publisher);
    assert.equal(firstTagValue(template.tags, 'web25-signature'), artifact.signature);
    assert.equal(firstTagValue(template.tags, 'web25-message'), artifact.message);
    assert.equal(firstTagValue(template.tags, 'web25-merkle-root'), artifact.payload.merkleRoot);
    assert.equal(firstTagValue(template.tags, 'web25-bundle-sha256'), artifact.payload.bundle.sha256);
    assert.equal(firstTagValue(template.tags, 'web25-chain-id'), `${artifact.payload.chainId}`);
    assert.equal(firstTagValue(template.tags, 'web25-schema'), artifact.payload.schema);
});

test('the mirrored message is the exact string the wallet signed', () => {
    const artifact = chainArtifact();
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: artifact });

    // Byte-identical, not re-serialized: a re-derived payload could differ in
    // key order and would no longer verify.
    assert.equal(firstTagValue(template.tags, 'web25-message'), JSON.stringify(artifact.payload));
});

test('building a registry event performs no EVM signing at all', async () => {
    let evmSignCalls = 0;
    const artifact = chainArtifact();

    // The builder is pure and synchronous: it is handed the existing proof and
    // has no signing handle to call even if it wanted one.
    const template = buildRegistryEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: {
            payload: artifact.payload,
            message: artifact.message,
            get signature() {
                evmSignCalls += 1;
                return artifact.signature;
            }
        }
    });

    assert.equal(evmSignCalls, 1, 'the existing signature is read once, never regenerated');
    assert.equal(firstTagValue(template.tags, 'web25-signature'), artifact.signature);
});

test('a site without a gzip bundle omits the bundle tags rather than inventing them', () => {
    const artifact = chainArtifact();
    delete artifact.payload.bundle;
    artifact.message = JSON.stringify(artifact.payload);

    const template = buildRegistryEventTemplate({ torrent: filesTorrent(), chainArtifact: artifact });
    assert.equal(firstTagValue(template.tags, 'web25-bundle-sha256'), '');
});

// ─── 3. Parsing and category filtering ───────────────────────────────────

test('a signed registry event parses into a normalized result', () => {
    const event = buildSigned();
    const result = parseRegistryEvent(event, { relayUrl: 'wss://relay.dtan.xyz', npubEncode });

    assert.equal(result.eventId, event.id);
    assert.equal(result.title, 'My Site');
    assert.equal(result.infohash, INFOHASH);
    assert.equal(result.nostrPubkey, nostrCore.getNostrPublicKey(NOSTR_PRIV));
    assert.equal(result.npub, npubEncode(result.nostrPubkey));
    assert.equal(result.web25Publisher, PUBLISHER);
    assert.equal(result.web25MerkleRoot, 'a'.repeat(64));
    assert.equal(result.web25BundleSha256, 'b'.repeat(64));
    assert.deepEqual(result.trackers, [TRACKER]);
    assert.deepEqual(result.torrentFiles, [
        { path: '.torrentchain', size: 1234 },
        { path: 'site.bundle.json.gz', size: 56789 }
    ]);
    assert.deepEqual(result.sourceRelays, ['wss://relay.dtan.xyz']);
});

test('unrelated torrents in other categories are ignored', () => {
    const foreign = signRegistryEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [
            ['title', 'Some Linux ISO'],
            ['x', INFOHASH],
            ['i', 'tcat:software,linux']
        ],
        content: ''
    });

    assert.equal(isWeb25RegistryEvent(foreign), false);
    assert.equal(parseRegistryEvent(foreign), null);
});

test('events of the wrong kind are ignored even in the right category', () => {
    const wrongKind = signRegistryEvent({
        kind: 1,
        created_at: 1800000000,
        tags: [['title', 'Not a torrent'], ['x', INFOHASH], ['i', 'tcat:web25.cloud,websites']],
        content: ''
    });

    assert.equal(isWeb25RegistryEvent(wrongKind), false);
    assert.equal(parseRegistryEvent(wrongKind), null);
});

test('structurally broken entries are dropped rather than listed', () => {
    const noHash = signRegistryEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [['title', 'No hash'], ['i', 'tcat:web25.cloud,websites']],
        content: ''
    });
    const badHash = signRegistryEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [['title', 'Bad hash'], ['x', 'not-a-hash'], ['i', 'tcat:web25.cloud,websites']],
        content: ''
    });
    const noTitle = signRegistryEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [['x', INFOHASH], ['i', 'tcat:web25.cloud,websites']],
        content: ''
    });

    assert.equal(parseRegistryEvent(noHash), null);
    assert.equal(parseRegistryEvent(badHash), null);
    assert.equal(parseRegistryEvent(noTitle), null);
});

// ─── 4. Verification: two separate signatures ────────────────────────────

/** Stand-in for `verifyPublishSignature`, matching its resolved contract. */
function evmVerifier({ expectMessage, expectSignature, address }) {
    return async (message, signature, publisher) =>
        message === expectMessage && signature === expectSignature && publisher.toLowerCase() === address.toLowerCase();
}

test('a valid mirrored EVM proof is marked verified', async () => {
    const artifact = chainArtifact();
    const result = parseRegistryEvent(buildSigned(), { npubEncode });

    const verified = await verifyRegistryProof(
        result,
        evmVerifier({ expectMessage: artifact.message, expectSignature: artifact.signature, address: PUBLISHER })
    );
    assert.equal(verified.web25VerificationState, WEB25_VERIFICATION.VERIFIED);
});

test('a valid Nostr signature alone does not imply a verified WEB25 publisher', async () => {
    const event = buildSigned();

    // The Nostr event itself is genuinely signed...
    assert.equal(nostrCore.verifyEvent(event), true);

    // ...but until the EVM proof is checked, the publisher is only a claim.
    const parsed = parseRegistryEvent(event, { npubEncode });
    assert.equal(parsed.web25VerificationState, WEB25_VERIFICATION.UNVERIFIED);

    const checked = await verifyRegistryProof(parsed, async () => false);
    assert.equal(checked.web25VerificationState, WEB25_VERIFICATION.INVALID);
});

test('an EVM signature that recovers to another address is not verified', async () => {
    const artifact = chainArtifact();
    const result = parseRegistryEvent(buildSigned(), { npubEncode });

    const verified = await verifyRegistryProof(
        result,
        evmVerifier({ expectMessage: artifact.message, expectSignature: artifact.signature, address: OTHER_PUBLISHER })
    );
    assert.equal(verified.web25VerificationState, WEB25_VERIFICATION.INVALID);
});

test('a verifier that throws yields invalid, never verified', async () => {
    const result = parseRegistryEvent(buildSigned(), { npubEncode });
    const verified = await verifyRegistryProof(result, async () => {
        throw new Error('viem unavailable');
    });
    assert.equal(verified.web25VerificationState, WEB25_VERIFICATION.INVALID);
});

test('convenience tags that disagree with the signed message are malformed', async () => {
    // A hostile publisher displays one address while proving another.
    const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: chainArtifact() });
    const tampered = template.tags.map((tag) => (tag[0] === 'web25-publisher' ? ['web25-publisher', OTHER_PUBLISHER] : tag));
    const event = signRegistryEvent({ ...template, tags: tampered });

    const result = parseRegistryEvent(event, { npubEncode });
    assert.equal(result.web25VerificationState, WEB25_VERIFICATION.MALFORMED);

    // ...and a malformed entry can never be promoted, even by a permissive verifier.
    const checked = await verifyRegistryProof(result, async () => true);
    assert.equal(checked.web25VerificationState, WEB25_VERIFICATION.MALFORMED);
});

test('malformed WEB25 metadata is rejected in every shape', () => {
    const cases = {
        'bad publisher': ['web25-publisher', 'not-an-address'],
        'bad signature': ['web25-signature', '0xdeadbeef'],
        'bad merkle root': ['web25-merkle-root', 'zz'],
        'unparseable message': ['web25-message', 'not json']
    };

    for (const [label, [tagName, badValue]] of Object.entries(cases)) {
        const template = buildRegistryEventTemplate({ torrent: gzipTorrent(), chainArtifact: chainArtifact() });
        const tags = template.tags.map((tag) => (tag[0] === tagName ? [tagName, badValue] : tag));
        const result = parseRegistryEvent(signRegistryEvent({ ...template, tags }), { npubEncode });

        assert.equal(result.web25VerificationState, WEB25_VERIFICATION.MALFORMED, label);
    }
});

test('a plain NIP-35 torrent in our category is listed but never verifiable', async () => {
    const event = signRegistryEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [['title', 'No WEB25 proof'], ['x', INFOHASH], ['i', 'tcat:web25.cloud,websites']],
        content: ''
    });

    const result = parseRegistryEvent(event, { npubEncode });
    assert.equal(result.web25VerificationState, WEB25_VERIFICATION.UNVERIFIED);

    const checked = await verifyRegistryProof(result, async () => true);
    assert.equal(checked.web25VerificationState, WEB25_VERIFICATION.UNVERIFIED, 'there is nothing to verify');
});

// ─── 5. Registry vs the downloaded .torrentchain ─────────────────────────

test('registry metadata matching the downloaded manifest is accepted', () => {
    const artifact = chainArtifact();
    const result = parseRegistryEvent(buildSigned(), { npubEncode });
    const manifest = { payload: artifact.payload, message: artifact.message, signature: artifact.signature };

    assert.deepEqual(matchesDownloadedManifest(result, manifest), { matches: true, mismatches: [] });
});

test('registry metadata disagreeing with the downloaded manifest is detected', () => {
    const artifact = chainArtifact();
    const result = parseRegistryEvent(buildSigned(), { npubEncode });

    const tamperedManifest = {
        payload: { ...artifact.payload, publisher: OTHER_PUBLISHER, merkleRoot: 'c'.repeat(64) },
        message: artifact.message,
        signature: artifact.signature
    };

    const comparison = matchesDownloadedManifest(result, tamperedManifest);
    assert.equal(comparison.matches, false);
    assert.deepEqual(comparison.mismatches.sort(), ['merkleRoot', 'publisher']);
});

test('a different signed message in the manifest is detected', () => {
    const result = parseRegistryEvent(buildSigned(), { npubEncode });
    const comparison = matchesDownloadedManifest(result, {
        payload: chainArtifact().payload,
        message: '{"schema":"something-else"}',
        signature: EVM_SIGNATURE
    });

    assert.equal(comparison.matches, false);
    assert.ok(comparison.mismatches.includes('message'));
});
