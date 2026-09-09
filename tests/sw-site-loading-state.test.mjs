/**
 * What `SITE_LOADING` does to the site the service worker is serving.
 *
 * The page sends `SITE_LOADING` twice per load: `start` when it begins, and
 * `stop` when the download phase ends — which, on the torrent path, is
 * immediately before the site is processed and `SITE_READY` announces the file
 * list. The handler used to reset on both, so any late `stop` (a torrent that
 * errors out after the GoFile mirror has already rendered the site, say) left a
 * rendered page in front of a service worker with an empty file list, which
 * answers its sub-resources with a 404.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @type {Set<Function>} */
const listeners = new Set();
global.self = {
    addEventListener: (name, listener) => {
        if (name === 'message') listeners.add(listener);
    },
    location: { origin: 'http://localhost' },
    clients: { claim: async () => {}, matchAll: async () => [] },
    skipWaiting: () => {}
};

const sw = require('../peerweb-sw.js');

const HASH = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

const post = (message) => {
    for (const listener of listeners) listener({ data: message });
};

const readySite = (hash = HASH) => {
    post({ type: 'SITE_LOADING', hash, state: 'start', loadId: 'load_1' });
    post({
        type: 'SITE_READY',
        hash,
        fileCount: 2,
        fileList: ['index.html', 'assets/app.css'],
        entryFile: 'index.html'
    });
};

test('a ready site survives the stop that ends its download phase', () => {
    readySite();
    assert.deepEqual(sw.__siteState().files, ['index.html', 'assets/app.css']);

    post({ type: 'SITE_LOADING', hash: HASH, state: 'stop', loadId: 'load_1' });

    const state = sw.__siteState();
    assert.equal(state.hash, HASH, 'the served site is still this one');
    assert.equal(state.entryFile, 'index.html', 'the entry file is still known');
    assert.deepEqual(state.files, ['index.html', 'assets/app.css'], 'the file list is intact');
});

test('a stray stop from an abandoned torrent cannot empty a mirrored render', () => {
    readySite();
    // The mirror rendered the site; the torrent it gave up on errors out later.
    post({ type: 'SITE_LOADING', hash: HASH, state: 'stop', loadId: 'load_1' });
    post({ type: 'SITE_LOADING', hash: HASH, state: 'stop', loadId: 'load_1' });

    assert.deepEqual(sw.__siteState().files, ['index.html', 'assets/app.css']);
});

test('starting a new load still replaces the served site', () => {
    readySite();
    post({ type: 'SITE_LOADING', hash: OTHER, state: 'start', loadId: 'load_2' });

    const state = sw.__siteState();
    assert.equal(state.hash, OTHER);
    assert.equal(state.entryFile, null);
    assert.deepEqual(state.files, [], 'the previous site is not served under the new hash');
    assert.equal(state.mediaCacheSize, 0);
});

test('a SITE_LOADING without a state is still treated as the start of a load', () => {
    readySite();
    post({ type: 'SITE_LOADING', hash: OTHER });

    assert.equal(sw.__siteState().hash, OTHER);
    assert.deepEqual(sw.__siteState().files, []);
});

test('unloading still clears everything', () => {
    readySite();
    post({ type: 'SITE_UNLOADED' });

    const state = sw.__siteState();
    assert.equal(state.hash, null);
    assert.deepEqual(state.files, []);
});
