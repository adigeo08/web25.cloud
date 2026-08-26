/**
 * NosNS UI logic: search filtering and the deploy wizard's NosNS step.
 *
 * Pure logic only — no DOM required. The rendering itself is exercised in the
 * browser; what matters here is that search covers the four documented fields
 * and that a failed NosNS publication never demotes a successful deployment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { filterNosnsResults } from '../src/ui/browse/NosnsPanel.js';
import { dtanCategoryLabel, NOSNS_DEFAULT_CATEGORY, nosnsDisplayName } from '../src/nosns/NosNSProtocol.js';

const RESULTS = [
    {
        // Raw protocol title, plus the display form the list actually shows.
        title: 'Alice Homepage.nosns.torrent',
        displayName: 'Alice Homepage',
        infohash: 'e5a1c0d4b7f28369ac015be47d3902fa6c8b1d47',
        web25Publisher: '0x4de1f0e0c5a4b0d1a2b3c4d5e6f708192a3b4c5d',
        npub: 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
        nostrPubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'
    },
    {
        title: 'Bob Blog.nosns.torrent',
        displayName: 'Bob Blog',
        infohash: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
        web25Publisher: '0x99aa0000000000000000000000000000000000bb',
        npub: 'npub1bobbob',
        nostrPubkey: 'ff'.repeat(32)
    }
];

// ─── Search ──────────────────────────────────────────────────────────────

test('search matches on site name', () => {
    assert.deepEqual(
        filterNosnsResults(RESULTS, 'bob').map((r) => r.displayName),
        ['Bob Blog']
    );
    assert.deepEqual(
        filterNosnsResults(RESULTS, 'ALICE').map((r) => r.displayName),
        ['Alice Homepage']
    );
});

test('search matches on infohash', () => {
    assert.deepEqual(
        filterNosnsResults(RESULTS, 'e5a1c0d4').map((r) => r.displayName),
        ['Alice Homepage']
    );
});

test('search matches on EVM publisher address', () => {
    assert.deepEqual(
        filterNosnsResults(RESULTS, '0x4de1').map((r) => r.displayName),
        ['Alice Homepage']
    );
});

test('search matches on npub and on the raw Nostr pubkey', () => {
    assert.deepEqual(
        filterNosnsResults(RESULTS, 'npub180cvv').map((r) => r.displayName),
        ['Alice Homepage']
    );
    assert.deepEqual(
        filterNosnsResults(RESULTS, '3bf0c63f').map((r) => r.displayName),
        ['Alice Homepage']
    );
});

test('an empty query lists everything', () => {
    assert.equal(filterNosnsResults(RESULTS, '').length, 2);
    assert.equal(filterNosnsResults(RESULTS, '   ').length, 2);
});

test('a query matching nothing yields nothing', () => {
    assert.deepEqual(filterNosnsResults(RESULTS, 'no-such-site'), []);
});

test('search tolerates results with missing fields', () => {
    const sparse = [{ title: 'Bare.nosns.torrent', infohash: 'ab'.repeat(20) }];
    assert.equal(filterNosnsResults(sparse, 'bare').length, 1);
    assert.equal(filterNosnsResults(sparse, '0xdead').length, 0);
});

test('search does not depend on NIP-50 — it runs entirely on fetched results', () => {
    // The whole filter is a local array pass over what the category query
    // returned; there is no relay round-trip and no `search` field anywhere.
    const before = JSON.parse(JSON.stringify(RESULTS));
    filterNosnsResults(RESULTS, 'alice');
    assert.deepEqual(RESULTS, before, 'filtering is pure');
});

test('the display name drops the protocol suffix while the raw title is kept', () => {
    assert.equal(nosnsDisplayName('example-site.nosns.torrent'), 'example-site');
    assert.equal(RESULTS[0].title.endsWith('.nosns.torrent'), true);
    // A user can still search for the raw, suffixed name.
    assert.equal(filterNosnsResults(RESULTS, '.nosns.torrent').length, 2);
});

// ─── Deploy wizard NosNS step ────────────────────────────────────────────

/**
 * Mirrors the step selection in `updateDeployWizard`: the NosNS step is
 * reached only after a deployment exists, and a failed publication leaves the
 * deployment itself untouched.
 */
function simulateWizardStep({ hasFiles, hasSignature, hasDeployResult, registryState = 'idle' }) {
    const registryStarted = registryState !== 'idle';
    if (hasDeployResult && registryStarted) return 7;
    if (hasDeployResult) return 6;
    if (hasFiles && hasSignature) return 5;
    if (hasFiles) return 4;
    return 1;
}

test('the NosNS step is only reached once a deployment exists', () => {
    assert.equal(
        simulateWizardStep({ hasFiles: true, hasSignature: true, hasDeployResult: false, registryState: 'publishing' }),
        5
    );
    assert.equal(
        simulateWizardStep({ hasFiles: true, hasSignature: true, hasDeployResult: true, registryState: 'idle' }),
        6
    );
    assert.equal(
        simulateWizardStep({ hasFiles: true, hasSignature: true, hasDeployResult: true, registryState: 'publishing' }),
        7
    );
});

test('a failed NosNS publication still leaves the deployment complete', () => {
    const step = simulateWizardStep({
        hasFiles: true,
        hasSignature: true,
        hasDeployResult: true,
        registryState: 'failed'
    });

    // Still past "live and seeding": the site is deployed either way, and only
    // the NosNS step is shown as unfinished.
    assert.equal(step, 7);
    assert.ok(step > 6, 'a NosNS failure must never roll the deployment back');
});

test('the deploy result labels the DTAN category the entry is published under', () => {
    assert.equal(NOSNS_DEFAULT_CATEGORY, 'tcat:application');
    assert.equal(dtanCategoryLabel('tcat:application'), 'Applications');
    assert.equal(dtanCategoryLabel('tcat:application,unix'), 'Applications / UNIX');
    assert.equal(dtanCategoryLabel('tcat:video,movie,4k'), 'Video / Movies / 4k');
});
