/**
 * A DTAN category is chosen, never assumed.
 *
 * The category decides where a site appears in DTAN. Defaulting it to
 * `application` because nobody picked would file the site somewhere the
 * publisher never chose and would not think to look — and the choice is frozen
 * into a signed event, so it is not something a later edit can correct.
 *
 * The counterweight is that NosNS must never block a deployment. So a missing
 * category skips publication rather than failing the deploy, and the skip is
 * recoverable: choosing a category and retrying publishes the site.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
    location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' }
};
globalThis.document = globalThis.document || {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
};
globalThis.localStorage = globalThis.localStorage || {
    _v: new Map(),
    getItem(k) {
        return this._v.has(k) ? this._v.get(k) : null;
    },
    setItem(k, v) {
        this._v.set(k, `${v}`);
    },
    removeItem(k) {
        this._v.delete(k);
    }
};

const { publishNosnsEntry, retryNosnsPublish, restoreNosnsCategory, setNosnsCategory, sendNosnsEvent } =
    await import('../src/core/bootstrap/Lifecycle.js');
import { buildNosnsEventTemplate } from '../src/nosns/NosNSEvent.js';
import { NOSNS_DEFAULT_CATEGORY } from '../src/nosns/NosNSProtocol.js';

const INFOHASH = 'e5a1c0d4b7f28369ac015be47d3902fa6c8b1d47';
const EVM_SIGNATURE = `0x${'9'.repeat(130)}`;

function torrent() {
    return {
        infoHash: INFOHASH,
        name: 'my-site.nosns.torrent',
        files: [{ path: 'my-site.nosns.torrent/.torrentchain', name: '.torrentchain', length: 1234 }],
        announce: ['wss://tracker.openwebtorrent.com/']
    };
}

function chainArtifact() {
    const payload = {
        schema: 'web25-torrentchain-v1',
        publisher: '0x1111111111111111111111111111111111111111',
        chainId: 1,
        createdAt: '2026-02-01T10:00:00.000Z',
        fileCount: 2,
        totalBytes: 1200,
        merkleRoot: 'a'.repeat(64),
        filesSemantics: 'bundle-contents'
    };
    return { payload, message: JSON.stringify(payload), signature: EVM_SIGNATURE };
}

/** The slice of the app `publishNosnsEntry` touches. */
function makeApp({ category = '' } = {}) {
    const artifact = chainArtifact();
    const app = {
        nosnsCategory: category,
        lastPublishCandidate: { hash: INFOHASH, siteName: 'my-site', torrent: torrent() },
        lastSignature: artifact,
        trackers: ['wss://tracker.openwebtorrent.com/'],
        registryPublication: null,
        lastRegistryEvent: null,
        nosnsResultCache: new Map(),
        signed: [],
        published: [],
        nosnsService: {
            relayStatus: [{ url: 'wss://relay.dtan.xyz', status: 'connected' }],
            signer: { getNostrIdentity: async () => ({ npub: 'npub1local' }) },
            async createSignedNosnsEvent(params) {
                // Delegates to the real builder, so a category the builder
                // would refuse is refused here too.
                const template = buildNosnsEventTemplate({
                    torrent: params.torrent,
                    chainArtifact: params.chainArtifact,
                    siteName: params.siteName,
                    trackers: params.trackers,
                    category: params.category
                });
                const event = { ...template, id: 'evt1', sig: 'sig1', pubkey: 'pk1' };
                app.signed.push(params.category);
                return event;
            },
            async publishSignedEvent(event) {
                app.published.push(event);
                return {
                    ok: true,
                    eventId: event.id,
                    accepted: ['wss://relay.dtan.xyz'],
                    rejected: {},
                    attempted: 1,
                    error: null
                };
            }
        },
        persistDeploySession() {},
        refreshDeployUiState() {},
        log() {},
        toasts: [],
        toast: {
            info: (m, t) => app.toasts.push({ level: 'info', m, t }),
            success: (m, t) => app.toasts.push({ level: 'success', m, t }),
            warning: (m, t) => app.toasts.push({ level: 'warning', m, t }),
            error: (m, t) => app.toasts.push({ level: 'error', m, t })
        }
    };

    app.publishNosnsEntry = publishNosnsEntry.bind(app);
    app.sendNosnsEvent = sendNosnsEvent.bind(app);
    app.retryNosnsPublish = retryNosnsPublish.bind(app);
    app.setNosnsCategory = setNosnsCategory.bind(app);
    return app;
}

test('publication is skipped when no category was chosen', async () => {
    const app = makeApp({ category: '' });
    await app.publishNosnsEntry();

    assert.deepEqual(app.signed, [], 'nothing is signed without a category');
    assert.deepEqual(app.published, []);
    assert.equal(app.registryPublication.ok, false);
    assert.match(app.registryPublication.error, /no dtan category/i);
});

test('a missing category never defaults to Applications behind the user', async () => {
    const app = makeApp({ category: '' });
    await app.publishNosnsEntry();

    assert.ok(!app.signed.includes(NOSNS_DEFAULT_CATEGORY), 'the default is not substituted silently');
    assert.equal(app.lastRegistryEvent, null);
});

test('the deployment is still reported as complete', async () => {
    const app = makeApp({ category: '' });
    await app.publishNosnsEntry();

    // NosNS must never block a deployment: the site is live and seeding either
    // way, and the message says what is missing rather than reading as failure.
    const messages = app.toasts.map((t) => `${t.m}`).join(' ');
    assert.match(messages, /live/i);
    assert.match(messages, /categor/i);
    assert.ok(!app.toasts.some((t) => t.level === 'error'));
});

test('choosing a category and retrying publishes the site', async () => {
    const app = makeApp({ category: '' });
    await app.publishNosnsEntry();
    assert.deepEqual(app.published, [], 'nothing published yet');

    // The user picks a category and presses Retry. There is no signed event to
    // resubmit, so retry has to build one rather than report nothing to do.
    app.nosnsCategory = 'tcat:other,archive';
    await app.retryNosnsPublish();

    assert.deepEqual(app.signed, ['tcat:other,archive']);
    assert.equal(app.published.length, 1);
    assert.equal(app.registryPublication.ok, true);
});

test('a chosen category is what gets signed', async () => {
    const app = makeApp({ category: 'tcat:video,movie,4k' });
    await app.publishNosnsEntry();

    assert.deepEqual(app.signed, ['tcat:video,movie,4k']);
    assert.equal(app.published.length, 1);
});

test('an invalid stored category is treated as no choice at all', async () => {
    const app = makeApp({ category: 'tcat:web25.cloud,websites' });
    await app.publishNosnsEntry();

    // Not silently rewritten to the default: an unrecognised value means the
    // user has not made a valid choice yet.
    assert.deepEqual(app.signed, []);
    assert.match(app.registryPublication.error, /no dtan category/i);
});

test('a category restored from storage is re-validated, not trusted', () => {
    const app = { log() {} };
    const restore = restoreNosnsCategory.bind(app);

    globalThis.localStorage.setItem('web25.nosns.category.v1', 'tcat:other,archive');
    assert.equal(restore(), 'tcat:other,archive');

    // An edited or stale key cannot put an unknown category into a signed event.
    globalThis.localStorage.setItem('web25.nosns.category.v1', 'tcat:web25.cloud,websites');
    assert.equal(restore(), '');

    globalThis.localStorage.removeItem('web25.nosns.category.v1');
    assert.equal(restore(), '', 'nothing stored means nothing chosen');
});
