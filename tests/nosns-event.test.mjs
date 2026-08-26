/**
 * NosNS over DTAN: NIP-35 event construction and the mirrored proof.
 *
 * The directory is discovery only. These tests pin what the event says, that
 * the `.nosns.torrent` suffix is the sole discriminator, that the proof is
 * mirrored from `.torrentchain` rather than derived a second time, and that the
 * two signatures involved stay distinct: a valid Nostr signature never implies
 * a verified WEB25 publisher.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildNosnsEventTemplate,
    describeTorrentArtifact,
    isNosnsEvent,
    matchesDownloadedManifest,
    parseNosnsEvent,
    verifyNosnsProof,
    WEB25_VERIFICATION,
    allTagValues,
    firstTagValue
} from '../src/nosns/NosNSEvent.js';
import { NOSNS_CONFIG } from '../src/config/nostr.config.js';
import {
    NOSNS_EVENT_KIND,
    NOSNS_TORRENT_SUFFIX,
    ensureNosnsTorrentName,
    isNosnsTorrentName,
    nosnsDisplayName
} from '../src/nosns/NosNSProtocol.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';

/** Publication no longer defaults a category, so tests name one explicitly. */
const CATEGORY = 'tcat:application';

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
        // The real BitTorrent info.name, which is what WEB25 seeds.
        name: 'my-site.nosns.torrent',
        files: [
            { path: 'my-site.nosns.torrent/.torrentchain', name: '.torrentchain', length: 1234 },
            { path: 'my-site.nosns.torrent/site.bundle.json.gz', name: 'site.bundle.json.gz', length: 56789 }
        ],
        announce: [TRACKER],
        ...overrides
    };
}

/** The torrent WEB25 creates when SITE_BUNDLE_MODE is `files`. */
function filesTorrent() {
    return {
        infoHash: INFOHASH,
        name: 'my-site.nosns.torrent',
        files: [
            { path: 'my-site.nosns.torrent/.torrentchain', name: '.torrentchain', length: 1234 },
            { path: 'my-site.nosns.torrent/index.html', name: 'index.html', length: 900 },
            { path: 'my-site.nosns.torrent/assets/app.css', name: 'app.css', length: 300 }
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
function signNosnsEvent(template, privateKey = NOSTR_PRIV) {
    return nostrCore.signEvent(template, privateKey);
}

function buildSigned(params = {}) {
    return signNosnsEvent(
        buildNosnsEventTemplate({
            torrent: gzipTorrent(),
            chainArtifact: chainArtifact(),
            category: CATEGORY,
            ...params
        })
    );
}

// ─── 1. Event construction ───────────────────────────────────────────────

test('the NosNS event is a NIP-35 kind 2003 torrent event', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    assert.equal(template.kind, 2003);
    assert.equal(NOSNS_CONFIG.TORRENT_EVENT_KIND, 2003);
});

test('the event carries the final torrent infohash in the x tag', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    assert.equal(firstTagValue(template.tags, 'x'), INFOHASH);
});

test('the category is one DTAN actually indexes', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });

    // DTAN resolves `tcat` against a fixed tree — video, audio, application,
    // game, porn, other. An invented path matches no filter there, so the entry
    // would never surface in the DTAN ecosystem.
    const DTAN_TOP_LEVEL_CATEGORIES = ['video', 'audio', 'application', 'game', 'porn', 'other'];
    const tcat = allTagValues(template.tags, 'i').find((value) => value.startsWith('tcat:'));

    assert.equal(tcat, 'tcat:application');
    assert.ok(DTAN_TOP_LEVEL_CATEGORIES.includes(tcat.slice('tcat:'.length).split(',')[0]));
    assert.ok(!tcat.includes('web25.cloud'), 'the custom category is gone');
});

test('the only i tag is the real DTAN category — no NosNS marker', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    const markers = allTagValues(template.tags, 'i');

    // NosNS identification is the title suffix and nothing else, so nothing is
    // parked in the `i` namespace beside the category DTAN itself indexes.
    assert.deepEqual(markers, ['tcat:application']);
    assert.ok(!markers.some((value) => value.includes('nosns')));
    assert.ok(!markers.some((value) => value.includes('web25')));
});

test('a chosen DTAN subcategory is what the event carries', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: 'tcat:other,archive'
    });
    assert.deepEqual(allTagValues(template.tags, 'i'), ['tcat:other,archive']);
});

test('a category outside the DTAN taxonomy cannot be published', () => {
    assert.throws(
        () =>
            buildNosnsEventTemplate({
                torrent: gzipTorrent(),
                chainArtifact: chainArtifact(),
                category: 'tcat:web25.cloud,websites'
            }),
        /categor/i
    );
});

test('the event matches the NIP-35 tag vocabulary', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    const NIP35_TAGS = new Set(['title', 'x', 'file', 'tracker', 'i', 't']);

    // Everything outside the NIP-35 vocabulary must be a namespaced WEB25 tag,
    // so a generic client can parse the event and ignore the rest.
    for (const [name] of template.tags) {
        assert.ok(NIP35_TAGS.has(name) || name.startsWith('web25-'), `unexpected tag name: ${name}`);
    }
    assert.equal(template.kind, 2003);
    assert.equal(typeof template.content, 'string');
});

test('no hashtags are added at all — not nosns, not the old web25 ones', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    assert.deepEqual(allTagValues(template.tags, 't'), []);

    const wire = JSON.stringify(template).toLowerCase();
    assert.ok(!wire.includes('"nosns"'), 'no ["t","nosns"] tag');
    assert.ok(!wire.includes('static-site'));
    assert.equal(template.kind, NOSNS_EVENT_KIND);
});

test('the title is the real torrent name and ends in the NosNS suffix', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    const title = firstTagValue(template.tags, 'title');

    assert.equal(title, 'my-site.nosns.torrent');
    assert.ok(isNosnsTorrentName(title));
    // NIP-35 says the title names the torrent, so it has to match info.name.
    assert.equal(title, gzipTorrent().name);
});

test('a display name never becomes the title — the torrent name does', () => {
    // NIP-35 says the title names the torrent. A separately derived site name
    // could drift from `info.name`, leaving the entry unfindable by the name it
    // is actually distributed under, so `siteName` is an assertion and a
    // disagreement is a hard failure rather than a silent relabel.
    assert.throws(
        () =>
            buildNosnsEventTemplate({
                torrent: gzipTorrent(),
                chainArtifact: chainArtifact(),
                category: CATEGORY,
                siteName: 'Some Other Name'
            }),
        /does not match the torrent name/i
    );

    // A site name that agrees is accepted, and the title is still info.name.
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY,
        siteName: 'my-site'
    });
    assert.equal(firstTagValue(template.tags, 'title'), gzipTorrent().name);
    assert.ok(firstTagValue(template.tags, 'title').endsWith(NOSNS_TORRENT_SUFFIX));
});

test('a torrent seeded without the NosNS suffix cannot be published', () => {
    // The suffix has to be in the real BitTorrent info.name. If the seeder did
    // not put it there, inventing it in the title would advertise a name the
    // torrent does not have.
    assert.throws(
        () =>
            buildNosnsEventTemplate({
                torrent: { ...gzipTorrent(), name: 'my-site' },
                chainArtifact: chainArtifact(),
                category: CATEGORY
            }),
        /not a NosNS name/i
    );
});

test('gzip mode advertises the actual torrent entries, not the bundled site files', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
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
    const template = buildNosnsEventTemplate({
        torrent: filesTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    const files = template.tags.filter((tag) => tag[0] === 'file');

    assert.deepEqual(files, [
        ['file', '.torrentchain', '1234'],
        ['file', 'index.html', '900'],
        ['file', 'assets/app.css', '300']
    ]);
});

test('the torrent name prefix is stripped from advertised file paths', () => {
    const artifact = describeTorrentArtifact(gzipTorrent());
    assert.deepEqual(
        artifact.files.map((file) => file.path),
        ['.torrentchain', 'site.bundle.json.gz']
    );
});

test('the actual tracker list is included', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    assert.deepEqual(allTagValues(template.tags, 'tracker'), [TRACKER]);
});

test('trackers fall back to the deployment configuration when the torrent has none', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent({ announce: [] }),
        chainArtifact: chainArtifact(),
        category: CATEGORY,
        trackers: ['wss://tracker.example/']
    });
    assert.deepEqual(allTagValues(template.tags, 'tracker'), ['wss://tracker.example/']);
});

test('the title falls back to the torrent name', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    assert.equal(firstTagValue(template.tags, 'title'), 'my-site.nosns.torrent');
});

test('an unseeded torrent or a missing .torrentchain cannot produce an event', () => {
    assert.throws(
        () =>
            buildNosnsEventTemplate({
                torrent: { infoHash: 'nope' },
                chainArtifact: chainArtifact(),
                category: CATEGORY
            }),
        /infohash/i
    );
    assert.throws(
        () =>
            buildNosnsEventTemplate({
                torrent: gzipTorrent(),
                chainArtifact: { payload: null, message: '', signature: '' }
            }),
        /signed .torrentchain artifact is required/i
    );
});

test('no private DM material can appear in a public NosNS event', () => {
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    const wire = JSON.stringify(template);

    for (const forbidden of ['sdp', 'candidate', 'ice', 'nsec', 'eciesPublicKey', 'nip44']) {
        assert.ok(!wire.toLowerCase().includes(forbidden), `a NosNS event must not mention ${forbidden}`);
    }
});

// ─── 2. Mirroring the .torrentchain proof ────────────────────────────────

test('NosNS mirrors the .torrentchain proof field for field', () => {
    const artifact = chainArtifact();
    const template = buildNosnsEventTemplate({ torrent: gzipTorrent(), chainArtifact: artifact, category: CATEGORY });

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
    const template = buildNosnsEventTemplate({ torrent: gzipTorrent(), chainArtifact: artifact, category: CATEGORY });

    // Byte-identical, not re-serialized: a re-derived payload could differ in
    // key order and would no longer verify.
    assert.equal(firstTagValue(template.tags, 'web25-message'), JSON.stringify(artifact.payload));
});

test('building a NosNS event performs no EVM signing at all', async () => {
    let evmSignCalls = 0;
    const artifact = chainArtifact();

    // The builder is pure and synchronous: it is handed the existing proof and
    // has no signing handle to call even if it wanted one.
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: {
            payload: artifact.payload,
            message: artifact.message,
            get signature() {
                evmSignCalls += 1;
                return artifact.signature;
            }
        },
        category: CATEGORY
    });

    assert.equal(evmSignCalls, 1, 'the existing signature is read once, never regenerated');
    assert.equal(firstTagValue(template.tags, 'web25-signature'), artifact.signature);
});

test('a site without a gzip bundle omits the bundle tags rather than inventing them', () => {
    const artifact = chainArtifact();
    delete artifact.payload.bundle;
    artifact.message = JSON.stringify(artifact.payload);

    const template = buildNosnsEventTemplate({ torrent: filesTorrent(), chainArtifact: artifact, category: CATEGORY });
    assert.equal(firstTagValue(template.tags, 'web25-bundle-sha256'), '');
});

// ─── 3. Parsing and category filtering ───────────────────────────────────

test('a signed NosNS event parses into a normalized result', () => {
    const event = buildSigned();
    const result = parseNosnsEvent(event, { relayUrl: 'wss://relay.dtan.xyz', npubEncode });

    assert.equal(result.eventId, event.id);
    // The raw title stays the protocol value; display strips the suffix.
    assert.equal(result.title, 'my-site.nosns.torrent');
    assert.equal(result.displayName, 'my-site');
    assert.equal(nosnsDisplayName(result.title), 'my-site');
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

test('unrelated torrents without the suffix are ignored', () => {
    const foreign = signNosnsEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [
            ['title', 'Some Linux ISO'],
            ['x', INFOHASH],
            ['i', 'tcat:video,movie']
        ],
        content: ''
    });

    assert.equal(isNosnsEvent(foreign), false);
    assert.equal(parseNosnsEvent(foreign), null);
});

test('a NosNS entry in any DTAN category is recognised by its suffix alone', () => {
    for (const category of ['tcat:video,movie,4k', 'tcat:other,archive', 'tcat:application,unix']) {
        const event = signNosnsEvent({
            kind: 2003,
            created_at: 1800000000,
            tags: [
                ['title', 'somewhere.nosns.torrent'],
                ['x', INFOHASH],
                ['i', category]
            ],
            content: ''
        });
        assert.equal(isNosnsEvent(event), true, category);
    }
});

test("someone else's application torrent is not mistaken for a NosNS site", () => {
    // NosNS shares DTAN's real categories, so the category alone must never
    // identify us — only the `.nosns.torrent` suffix may.
    const neighbour = signNosnsEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [
            ['title', 'Some Windows App'],
            ['x', INFOHASH],
            ['i', 'tcat:application'],
            ['t', 'windows']
        ],
        content: ''
    });

    assert.equal(isNosnsEvent(neighbour), false);
    assert.equal(parseNosnsEvent(neighbour), null);
});

test('the old WEB25 marker and hashtags no longer identify anything', () => {
    const base = { kind: 2003, created_at: 1800000000, content: '' };
    const byMarker = signNosnsEvent({
        ...base,
        tags: [
            ['title', 'A'],
            ['x', INFOHASH],
            ['i', 'tcat:application'],
            ['i', 'web25:website']
        ]
    });
    const byHashtag = signNosnsEvent({
        ...base,
        tags: [
            ['title', 'B'],
            ['x', INFOHASH],
            ['i', 'tcat:application'],
            ['t', 'web25']
        ]
    });

    assert.equal(isNosnsEvent(byMarker), false);
    assert.equal(isNosnsEvent(byHashtag), false);
});

test('events of the wrong kind are ignored even with the right suffix', () => {
    const wrongKind = signNosnsEvent({
        kind: 1,
        created_at: 1800000000,
        tags: [
            ['title', 'not-a-torrent.nosns.torrent'],
            ['x', INFOHASH],
            ['i', 'tcat:application']
        ],
        content: ''
    });

    assert.equal(isNosnsEvent(wrongKind), false);
    assert.equal(parseNosnsEvent(wrongKind), null);
});

test('structurally broken entries are dropped rather than listed', () => {
    const noHash = signNosnsEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [
            ['title', 'no-hash.nosns.torrent'],
            ['i', 'tcat:application']
        ],
        content: ''
    });
    const badHash = signNosnsEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [
            ['title', 'bad-hash.nosns.torrent'],
            ['x', 'not-a-hash'],
            ['i', 'tcat:application']
        ],
        content: ''
    });
    const noTitle = signNosnsEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [
            ['x', INFOHASH],
            ['i', 'tcat:application']
        ],
        content: ''
    });

    assert.equal(parseNosnsEvent(noHash), null);
    assert.equal(parseNosnsEvent(badHash), null);
    assert.equal(parseNosnsEvent(noTitle), null);
});

// ─── 4. Verification: two separate signatures ────────────────────────────

/** Stand-in for `verifyPublishSignature`, matching its resolved contract. */
function evmVerifier({ expectMessage, expectSignature, address }) {
    return async (message, signature, publisher) =>
        message === expectMessage && signature === expectSignature && publisher.toLowerCase() === address.toLowerCase();
}

test('a valid mirrored EVM proof is marked verified', async () => {
    const artifact = chainArtifact();
    const result = parseNosnsEvent(buildSigned(), { npubEncode });

    const verified = await verifyNosnsProof(
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
    const parsed = parseNosnsEvent(event, { npubEncode });
    assert.equal(parsed.web25VerificationState, WEB25_VERIFICATION.UNVERIFIED);

    const checked = await verifyNosnsProof(parsed, async () => false);
    assert.equal(checked.web25VerificationState, WEB25_VERIFICATION.INVALID);
});

test('an EVM signature that recovers to another address is not verified', async () => {
    const artifact = chainArtifact();
    const result = parseNosnsEvent(buildSigned(), { npubEncode });

    const verified = await verifyNosnsProof(
        result,
        evmVerifier({ expectMessage: artifact.message, expectSignature: artifact.signature, address: OTHER_PUBLISHER })
    );
    assert.equal(verified.web25VerificationState, WEB25_VERIFICATION.INVALID);
});

test('a verifier that throws yields invalid, never verified', async () => {
    const result = parseNosnsEvent(buildSigned(), { npubEncode });
    const verified = await verifyNosnsProof(result, async () => {
        throw new Error('viem unavailable');
    });
    assert.equal(verified.web25VerificationState, WEB25_VERIFICATION.INVALID);
});

test('convenience tags that disagree with the signed message are malformed', async () => {
    // A hostile publisher displays one address while proving another.
    const template = buildNosnsEventTemplate({
        torrent: gzipTorrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    const tampered = template.tags.map((tag) =>
        tag[0] === 'web25-publisher' ? ['web25-publisher', OTHER_PUBLISHER] : tag
    );
    const event = signNosnsEvent({ ...template, tags: tampered });

    const result = parseNosnsEvent(event, { npubEncode });
    assert.equal(result.web25VerificationState, WEB25_VERIFICATION.MALFORMED);

    // ...and a malformed entry can never be promoted, even by a permissive verifier.
    const checked = await verifyNosnsProof(result, async () => true);
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
        const template = buildNosnsEventTemplate({
            torrent: gzipTorrent(),
            chainArtifact: chainArtifact(),
            category: CATEGORY
        });
        const tags = template.tags.map((tag) => (tag[0] === tagName ? [tagName, badValue] : tag));
        const result = parseNosnsEvent(signNosnsEvent({ ...template, tags }), { npubEncode });

        assert.equal(result.web25VerificationState, WEB25_VERIFICATION.MALFORMED, label);
    }
});

test('a suffix-only entry with no WEB25 proof is listed but never verifiable', async () => {
    // NosNS discovery must not depend on the WEB25 proof tags: an entry that
    // carries the suffix and nothing else is a NosNS website, shown unverified.
    const event = signNosnsEvent({
        kind: 2003,
        created_at: 1800000000,
        tags: [
            ['title', 'no-proof.nosns.torrent'],
            ['x', INFOHASH],
            ['i', 'tcat:application']
        ],
        content: ''
    });

    const result = parseNosnsEvent(event, { npubEncode });
    assert.equal(result.web25VerificationState, WEB25_VERIFICATION.UNVERIFIED);

    const checked = await verifyNosnsProof(result, async () => true);
    assert.equal(checked.web25VerificationState, WEB25_VERIFICATION.UNVERIFIED, 'there is nothing to verify');
});

// ─── 5. Directory claim vs the downloaded .torrentchain ──────────────────

test('directory metadata matching the downloaded manifest is accepted', () => {
    const artifact = chainArtifact();
    const result = parseNosnsEvent(buildSigned(), { npubEncode });
    const manifest = { payload: artifact.payload, message: artifact.message, signature: artifact.signature };

    assert.deepEqual(matchesDownloadedManifest(result, manifest), { matches: true, mismatches: [] });
});

test('directory metadata disagreeing with the downloaded manifest is detected', () => {
    const artifact = chainArtifact();
    const result = parseNosnsEvent(buildSigned(), { npubEncode });

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
    const result = parseNosnsEvent(buildSigned(), { npubEncode });
    const comparison = matchesDownloadedManifest(result, {
        payload: chainArtifact().payload,
        message: '{"schema":"something-else"}',
        signature: EVM_SIGNATURE
    });

    assert.equal(comparison.matches, false);
    assert.ok(comparison.mismatches.includes('message'));
});
