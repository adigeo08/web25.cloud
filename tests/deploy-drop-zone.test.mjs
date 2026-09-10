/**
 * The staging zone on Step 1 of the deploy wizard.
 *
 * It is drawn as one dashed panel that says "drop a folder here", so it has to
 * behave like one: a click anywhere on it opens the picker, and a folder
 * dropped anywhere on it is read through rather than staged as an unreadable
 * directory handle. The DOM surface is hand-built here for the same reason the
 * deploy helper builds its own — this models only what setupDragAndDrop
 * touches, and index.html drift is caught by the markup tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function element(id) {
    const node = { id, listeners: {}, attributes: {}, classNames: new Set(), clicks: 0 };
    node.addEventListener = (type, handler) => {
        (node.listeners[type] = node.listeners[type] || []).push(handler);
    };
    // A real event always carries these; the tests only supply what they assert on.
    node.dispatch = (type, event = {}) => {
        const full = { preventDefault() {}, stopPropagation() {}, ...event };
        (node.listeners[type] || []).forEach((h) => h(full));
    };
    node.setAttribute = (name, value) => {
        node.attributes[name] = value;
    };
    node.click = () => {
        node.clicks += 1;
    };
    node.classList = {
        add: (name) => node.classNames.add(name),
        remove: (name) => node.classNames.delete(name),
        contains: (name) => node.classNames.has(name)
    };
    return node;
}

/** setupDragAndDrop, wired to a fake zone, reporting what reached the bundler. */
async function harness() {
    const nodes = {
        'drop-zone': element('drop-zone'),
        'folder-input': element('folder-input'),
        'torrent-input': element('torrent-input'),
        'select-folder': element('select-folder'),
        'select-torrent': element('select-torrent')
    };
    globalThis.document = { getElementById: (id) => nodes[id] || null };

    const staged = [];
    const logs = [];
    const uploader = await import('../src/core/torrent/TorrentUploader.js');
    uploader.setupDragAndDrop.call({
        handleDroppedFiles: (files) => staged.push(files),
        log: (line) => logs.push(line)
    });

    return { zone: nodes['drop-zone'], input: nodes['folder-input'], staged, logs };
}

/** A dropped item, as `webkitGetAsEntry` hands it over. */
const fileEntry = (fullPath) => ({
    isFile: true,
    fullPath,
    file: (resolve) => resolve({ name: fullPath.split('/').pop() })
});

const dirEntry = (fullPath, children) => ({
    isDirectory: true,
    fullPath,
    createReader() {
        let sent = false;
        return {
            // The real reader returns a batch, then an empty one to say it is
            // finished — a single call is never the whole directory.
            readEntries(resolve) {
                if (sent) return resolve([]);
                sent = true;
                resolve(children);
            }
        };
    }
});

const drop = (entries, files = []) => ({
    dataTransfer: {
        items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry })),
        files
    }
});

test('a click anywhere on the zone opens the folder picker', async () => {
    const { zone, input } = await harness();
    zone.dispatch('click', { target: { closest: () => null } });
    assert.equal(input.clicks, 1);
});

test('a click on the button inside it does not open the picker twice', async () => {
    const { zone, input } = await harness();
    // The button has its own listener; the zone must leave that click alone.
    zone.dispatch('click', { target: { closest: (sel) => (sel.includes('button') ? {} : null) } });
    assert.equal(input.clicks, 0);
});

test('the zone is not itself a button, because it contains one', async () => {
    const { zone } = await harness();
    // role="button" on a wrapper holding a real <button> is invalid ARIA, and
    // the inner "Select Folder" button already gives keyboard users the picker.
    // Clicking the panel is a pointer shortcut, not the only way in.
    assert.equal(zone.attributes.role, undefined);
    assert.equal(zone.attributes.tabindex, undefined);
});

test('a dropped folder is read through, with paths the bundler understands', async () => {
    const { zone, staged } = await harness();
    zone.dispatch(
        'drop',
        drop([
            dirEntry('/site', [
                fileEntry('/site/index.html'),
                dirEntry('/site/assets', [fileEntry('/site/assets/app.css')])
            ])
        ])
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(staged.length, 1);
    // Root folder included and no leading slash — the shape webkitdirectory
    // produces, so a dropped folder and a picked one bundle identically.
    assert.deepEqual(
        staged[0].map((file) => file.path),
        ['site/index.html', 'site/assets/app.css']
    );
});

test('loose files still stage when the browser offers no entry API', async () => {
    const { zone, staged } = await harness();
    zone.dispatch('drop', {
        dataTransfer: { items: null, files: [{ name: 'index.html' }] }
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
        staged[0].map((file) => file.name),
        ['index.html']
    );
});

test('an unreadable directory falls back to the flat list rather than staging nothing', async () => {
    const { zone, staged } = await harness();
    const unreadable = {
        isDirectory: true,
        fullPath: '/site',
        createReader: () => ({ readEntries: (_resolve, reject) => reject(new Error('denied')) })
    };
    zone.dispatch('drop', drop([unreadable], [{ name: 'index.html' }]));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
        staged[0].map((file) => file.name),
        ['index.html']
    );
});

test('the highlight survives the pointer crossing children inside the zone', async () => {
    const { zone } = await harness();
    zone.dispatch('dragenter', {});
    zone.dispatch('dragenter', {}); // onto the icon
    zone.dispatch('dragleave', {}); // off the icon, still over the zone
    assert.ok(zone.classList.contains('drag-over'), 'still highlighted between children');

    zone.dispatch('dragleave', {});
    assert.ok(!zone.classList.contains('drag-over'), 'cleared on the way out');
});

test('the highlight clears on drop', async () => {
    const { zone } = await harness();
    zone.dispatch('dragenter', {});
    zone.dispatch('drop', drop([fileEntry('/index.html')]));
    assert.ok(!zone.classList.contains('drag-over'));
});

test('a drop that throws while reading still stages what it can, and says so', async () => {
    const { zone, staged, logs } = await harness();
    const exploding = {
        isFile: true,
        fullPath: '/index.html',
        file() {
            throw new Error('read failed');
        }
    };
    zone.dispatch('drop', drop([exploding], [{ name: 'index.html' }]));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
        staged[0].map((file) => file.name),
        ['index.html']
    );
    assert.ok(
        logs.some((line) => line.includes('Could not read the dropped folder')),
        'a silent failure is the one outcome to avoid'
    );
});
