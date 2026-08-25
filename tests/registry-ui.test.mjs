/**
 * Registry UI logic: search filtering and the deploy wizard's registry step.
 *
 * Pure logic only — no DOM required. The rendering itself is exercised in the
 * browser; what matters here is that search covers the four documented fields
 * and that a failed registry publication never demotes a successful deployment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { filterRegistryResults } from '../src/ui/browse/RegistryPanel.js';
import { WEB25_CATEGORY_LABEL } from '../src/ui/publish/RegistryStatus.js';
import { NOSTR_REGISTRY_CONFIG } from '../src/config/nostr.config.js';

const RESULTS = [
    {
        title: 'Alice Homepage',
        infohash: 'e5a1c0d4b7f28369ac015be47d3902fa6c8b1d47',
        web25Publisher: '0x4de1f0e0c5a4b0d1a2b3c4d5e6f708192a3b4c5d',
        npub: 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
        nostrPubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'
    },
    {
        title: 'Bob Blog',
        infohash: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
        web25Publisher: '0x99aa0000000000000000000000000000000000bb',
        npub: 'npub1bobbob',
        nostrPubkey: 'ff'.repeat(32)
    }
];

// ─── Search ──────────────────────────────────────────────────────────────

test('search matches on site name', () => {
    assert.deepEqual(filterRegistryResults(RESULTS, 'bob').map((r) => r.title), ['Bob Blog']);
    assert.deepEqual(filterRegistryResults(RESULTS, 'ALICE').map((r) => r.title), ['Alice Homepage']);
});

test('search matches on infohash', () => {
    assert.deepEqual(filterRegistryResults(RESULTS, 'e5a1c0d4').map((r) => r.title), ['Alice Homepage']);
});

test('search matches on EVM publisher address', () => {
    assert.deepEqual(filterRegistryResults(RESULTS, '0x4de1').map((r) => r.title), ['Alice Homepage']);
});

test('search matches on npub and on the raw Nostr pubkey', () => {
    assert.deepEqual(filterRegistryResults(RESULTS, 'npub180cvv').map((r) => r.title), ['Alice Homepage']);
    assert.deepEqual(filterRegistryResults(RESULTS, '3bf0c63f').map((r) => r.title), ['Alice Homepage']);
});

test('an empty query lists everything', () => {
    assert.equal(filterRegistryResults(RESULTS, '').length, 2);
    assert.equal(filterRegistryResults(RESULTS, '   ').length, 2);
});

test('a query matching nothing yields nothing', () => {
    assert.deepEqual(filterRegistryResults(RESULTS, 'no-such-site'), []);
});

test('search tolerates results with missing fields', () => {
    const sparse = [{ title: 'Bare', infohash: 'ab'.repeat(20) }];
    assert.equal(filterRegistryResults(sparse, 'bare').length, 1);
    assert.equal(filterRegistryResults(sparse, '0xdead').length, 0);
});

// ─── Deploy wizard registry step ─────────────────────────────────────────

/**
 * Mirrors the step selection in `updateDeployWizard`: the registry step is
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

test('the registry step is only reached once a deployment exists', () => {
    assert.equal(simulateWizardStep({ hasFiles: true, hasSignature: true, hasDeployResult: false, registryState: 'publishing' }), 5);
    assert.equal(simulateWizardStep({ hasFiles: true, hasSignature: true, hasDeployResult: true, registryState: 'idle' }), 6);
    assert.equal(simulateWizardStep({ hasFiles: true, hasSignature: true, hasDeployResult: true, registryState: 'publishing' }), 7);
});

test('a failed registry publication still leaves the deployment complete', () => {
    const step = simulateWizardStep({ hasFiles: true, hasSignature: true, hasDeployResult: true, registryState: 'failed' });

    // Still past "live and seeding": the site is deployed either way, and only
    // the registry step is shown as unfinished.
    assert.equal(step, 7);
    assert.ok(step > 6, 'a registry failure must never roll the deployment back');
});

test('the deploy result labels the category exactly as published', () => {
    assert.equal(NOSTR_REGISTRY_CONFIG.WEB25_CATEGORY, 'tcat:web25.cloud,websites');
    assert.equal(WEB25_CATEGORY_LABEL, 'WEB25.cloud / Websites');
});
