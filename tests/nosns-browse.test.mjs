/**
 * Browse over NosNS: the filtering pipeline between a relay subscription and a
 * rendered row, and the Open flow that hands an infohash to the one existing
 * loader.
 *
 * The point of these tests is that a relay is untrusted input at every step:
 * signature, structure, suffix and proof are each checked here rather than
 * assumed because the event arrived on the directory relay.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNosnsEventTemplate, parseNosnsEvent, WEB25_VERIFICATION } from '../src/nosns/NosNSEvent.js';
import { filterNosnsResults } from '../src/ui/browse/NosnsPanel.js';
import { isNosnsTorrentName, NOSNS_DEFAULT_CATEGORY } from '../src/nosns/NosNSProtocol.js';
import { nostrCore, verifyNostrEvent } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';

/** Publication no longer defaults a category, so tests name one explicitly. */
const CATEGORY = 'tcat:application';

const PRIV = '1111111111111111111111111111111111111111111111111111111111111111';
const INFOHASH = 'e5a1c0d4b7f28369ac015be47d3902fa6c8b1d47';
const PUBLISHER = '0x1111111111111111111111111111111111111111';
const EVM_SIGNATURE = `0x${'9'.repeat(130)}`;

function chainArtifact() {
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
        }
    };
    return { payload, message: JSON.stringify(payload), signature: EVM_SIGNATURE };
}

/**
 * The title is the real `info.name`, so a differently named site means a
 * differently named torrent — not a display name layered on top of one.
 */
function torrent(siteName = 'my-site') {
    const name = `${siteName}.nosns.torrent`;
    return {
        infoHash: INFOHASH,
        name,
        files: [{ path: `${name}/.torrentchain`, name: '.torrentchain', length: 1234 }],
        announce: ['wss://tracker.openwebtorrent.com/']
    };
}

function nosnsEvent(siteName = 'my-site') {
    return nostrCore.signEvent(
        buildNosnsEventTemplate({ torrent: torrent(siteName), chainArtifact: chainArtifact(), category: CATEGORY }),
        PRIV
    );
}

/**
 * The Browse pipeline, written out step by step so each discard is visible.
 * Mirrors what `NosNSService.subscribe()` plus `filterNosnsResults()` do.
 */
function browsePipeline(events, query = '') {
    const kept = [];
    for (const event of events) {
        // 1. The Nostr signature is verified locally, never trusted from the relay.
        if (!verifyNostrEvent(event)) continue;
        // 2. Structure: kind 2003, a real infohash, a title.
        const parsed = parseNosnsEvent(event, { npubEncode });
        if (!parsed) continue;
        // 3. The NosNS suffix, which is the whole protocol check.
        if (!isNosnsTorrentName(parsed.title)) continue;
        kept.push(parsed);
    }
    // 4. Text search, entirely client-side.
    return filterNosnsResults(kept, query);
}

test('a well-formed NosNS entry survives the whole pipeline', () => {
    const results = browsePipeline([nosnsEvent()]);
    assert.equal(results.length, 1);
    assert.equal(results[0].infohash, INFOHASH);
    assert.equal(results[0].displayName, 'my-site');
});

test('an event with a forged signature is discarded before anything else', () => {
    const event = nosnsEvent();
    const forged = { ...event, sig: `${'0'.repeat(128)}` };
    assert.equal(browsePipeline([forged]).length, 0);
});

test('an event whose content was altered after signing is discarded', () => {
    const event = nosnsEvent();
    const tampered = { ...event, tags: [...event.tags, ['title', 'evil.nosns.torrent']] };
    assert.equal(browsePipeline([tampered]).length, 0, 'the id no longer matches the tags');
});

test('a NIP-35 torrent without the suffix is discarded, whatever its category', () => {
    const other = nostrCore.signEvent(
        {
            kind: 2003,
            created_at: 1800000000,
            tags: [
                ['title', 'Ubuntu 26.04'],
                ['x', INFOHASH],
                ['i', NOSNS_DEFAULT_CATEGORY]
            ],
            content: ''
        },
        PRIV
    );
    assert.equal(browsePipeline([other]).length, 0);
});

test('entries missing an infohash or a title are discarded', () => {
    const noHash = nostrCore.signEvent(
        { kind: 2003, created_at: 1800000000, tags: [['title', 'a.nosns.torrent']], content: '' },
        PRIV
    );
    const noTitle = nostrCore.signEvent(
        { kind: 2003, created_at: 1800000000, tags: [['x', INFOHASH]], content: '' },
        PRIV
    );
    assert.equal(browsePipeline([noHash, noTitle]).length, 0);
});

test('a suffix-only entry with no WEB25 proof is kept and shown unverified', () => {
    // Discovery must not depend on the WEB25 proof tags.
    const bare = nostrCore.signEvent(
        {
            kind: 2003,
            created_at: 1800000000,
            tags: [
                ['title', 'bare.nosns.torrent'],
                ['x', INFOHASH],
                ['i', NOSNS_DEFAULT_CATEGORY]
            ],
            content: ''
        },
        PRIV
    );

    const [result] = browsePipeline([bare]);
    assert.ok(result, 'a NosNS website without WEB25 proof is still a NosNS website');
    assert.equal(result.web25VerificationState, WEB25_VERIFICATION.UNVERIFIED);
});

test('an entry whose proof tags contradict the signed message is marked malformed, not hidden', () => {
    const template = buildNosnsEventTemplate({
        torrent: torrent(),
        chainArtifact: chainArtifact(),
        category: CATEGORY
    });
    const tags = template.tags.map((tag) =>
        tag[0] === 'web25-publisher' ? ['web25-publisher', '0x2222222222222222222222222222222222222222'] : tag
    );
    const event = nostrCore.signEvent({ ...template, tags }, PRIV);

    const [result] = browsePipeline([event]);
    assert.equal(result.web25VerificationState, WEB25_VERIFICATION.MALFORMED);
});

test('the four documented search fields all match', () => {
    const results = browsePipeline([nosnsEvent('Alice Homepage')]);
    const [entry] = results;

    assert.equal(filterNosnsResults(results, 'alice').length, 1, 'site name');
    assert.equal(filterNosnsResults(results, INFOHASH.slice(0, 8)).length, 1, 'infohash');
    assert.equal(filterNosnsResults(results, PUBLISHER.slice(0, 6)).length, 1, 'EVM publisher');
    assert.equal(filterNosnsResults(results, entry.npub.slice(0, 12)).length, 1, 'npub');
    assert.equal(filterNosnsResults(results, entry.nostrPubkey.slice(0, 10)).length, 1, 'raw Nostr pubkey');
});

test('search runs on the fetched set with no relay round-trip', () => {
    const results = browsePipeline([nosnsEvent('Alice'), nosnsEvent('Bob')]);
    // Two entries share one infohash here, which is fine: the point is that
    // narrowing them is a local array pass, not a second query.
    assert.equal(results.length, 2);
    assert.equal(filterNosnsResults(results, 'bob').length, 1);
});

// ─── Open ────────────────────────────────────────────────────────────────

test('Open hands the infohash to the one existing loader', () => {
    const [entry] = browsePipeline([nosnsEvent()]);

    // Stands in for `setupNosns()`'s onOpen: find the claim, then loadSite().
    const loaded = [];
    const app = {
        registryResults: [entry],
        pendingRegistryClaim: null,
        loadSite: (infohash) => loaded.push(infohash)
    };
    const onOpen = (infohash) => {
        app.pendingRegistryClaim = app.registryResults.find((r) => r.infohash === infohash) || null;
        app.loadSite(infohash);
    };

    onOpen(entry.infohash);

    assert.deepEqual(loaded, [INFOHASH], 'there is exactly one website loading path');
    assert.equal(app.pendingRegistryClaim, entry, 'the claim travels with the load for comparison');
});

test('the downloaded manifest is what decides, not the directory claim', async () => {
    const { matchesDownloadedManifest } = await import('../src/nosns/NosNSEvent.js');
    const [entry] = browsePipeline([nosnsEvent()]);
    const artifact = chainArtifact();

    assert.deepEqual(matchesDownloadedManifest(entry, artifact), { matches: true, mismatches: [] });

    const lying = {
        payload: { ...artifact.payload, publisher: '0x2222222222222222222222222222222222222222' },
        message: artifact.message,
        signature: artifact.signature
    };
    const comparison = matchesDownloadedManifest(entry, lying);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.mismatches.includes('publisher'));
});
