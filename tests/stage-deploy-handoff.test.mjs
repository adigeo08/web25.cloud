/**
 * Files handed to Deploy from elsewhere in the app are staged like a dropped
 * folder: the Deploy tab is opened and the files go through the same
 * `handleDroppedFiles` a drop or a folder picker uses — nothing else about the
 * deployment changes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { STAGE_DEPLOY_EVENT, folderFile, stageDeployFiles } from '../src/ui/publish/StageDeploy.js';

test('the Deploy tab stages handed-over files exactly like a dropped folder', async () => {
    const previous = { window: globalThis.window, document: globalThis.document };
    const target = new EventTarget();
    let tabClicks = 0;
    globalThis.window = Object.assign(target, { location: { hostname: 'localhost', origin: 'http://localhost' } });
    globalThis.document = {
        getElementById: () => null,
        querySelector: (selector) =>
            selector === '.tab-nav .tab-btn[data-tab="publish"]' ? { click: () => (tabClicks += 1) } : null,
        querySelectorAll: () => [],
        addEventListener: () => {}
    };
    try {
        const { setupEventListeners } = await import('../src/core/bootstrap/Lifecycle.js');
        const staged = [];
        // Everything setupEventListeners wires besides the hand-off is a no-op here.
        const self = new Proxy(
            { handleDroppedFiles: (files) => staged.push(files) },
            { get: (object, key) => (key in object ? object[key] : () => {}) }
        );
        setupEventListeners.call(self);

        const files = [folderFile('llama-page/index.html', '<h1>Hi</h1>', 'text/html')];
        stageDeployFiles(files, { source: 'webllm', target });
        assert.equal(tabClicks, 1);
        assert.equal(staged.length, 1);
        assert.equal(staged[0][0].webkitRelativePath, 'llama-page/index.html');

        // An empty hand-off is nothing to stage.
        target.dispatchEvent(new CustomEvent(STAGE_DEPLOY_EVENT, { detail: { files: [] } }));
        assert.equal(staged.length, 1);
    } finally {
        globalThis.window = previous.window;
        globalThis.document = previous.document;
    }
});
