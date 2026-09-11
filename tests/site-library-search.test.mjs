/**
 * Finding a cached site again.
 *
 * A WEB25 address is a 40-character hash, so "the site I looked at last week"
 * is unfindable without an index. These tests pin what a site is indexed by,
 * that the index stays small, and that a query narrows rather than widens.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLibraryEntry, findEntryPath, searchLibrary } from '../src/cache/SiteLibraryIndex.js';

const encode = (text) => new TextEncoder().encode(text);

function siteData(html, extra = {}) {
    return {
        'index.html': { content: encode(html), type: 'text/html', size: html.length },
        'assets/app.js': { content: encode('console.log(1)'), type: 'text/javascript', size: 14 },
        '.torrentchain': { content: encode('{}'), type: 'application/json', size: 2 },
        ...extra
    };
}

const PAGE = `
<!doctype html>
<html><head>
  <title>Mara's Darkroom</title>
  <meta name="description" content="Film photography notes and a print shop." />
  <meta name="keywords" content="photography, darkroom, prints" />
</head><body>…</body></html>`;

test('a site is indexed by what it calls itself', () => {
    const entry = buildLibraryEntry({
        hash: 'ABCDEF0123456789abcdef0123456789ABCDEF01',
        siteData: siteData(PAGE),
        signatureState: { publisher: '0xabc0000000000000000000000000000000000001', verified: true, label: 'ok' },
        timestamp: 1700000000000
    });

    assert.equal(entry.hash, 'abcdef0123456789abcdef0123456789abcdef01', 'hashes are stored lowercase');
    assert.equal(entry.title, "Mara's Darkroom");
    assert.equal(entry.description, 'Film photography notes and a print shop.');
    assert.equal(entry.keywords, 'photography, darkroom, prints');
    assert.equal(entry.verified, true);
    assert.equal(entry.entryPath, 'index.html');
});

test('protocol furniture is not content', () => {
    const entry = buildLibraryEntry({ hash: 'a'.repeat(40), siteData: siteData(PAGE) });

    assert.ok(!entry.files.includes('.torrentchain'), 'a dotfile is not something a person searches for');
    assert.deepEqual(entry.files.sort(), ['assets/app.js', 'index.html']);
    assert.equal(entry.fileCount, 2);
});

test('a site with no title still indexes by its file names', () => {
    const entry = buildLibraryEntry({
        hash: 'b'.repeat(40),
        siteData: { 'gallery.html': { content: encode('<html><body>hi</body></html>'), size: 27 } }
    });

    assert.equal(entry.title, '');
    assert.equal(findEntryPath({ 'gallery.html': {} }), 'gallery.html');
    assert.deepEqual(searchLibrary([entry], 'gallery').length, 1);
});

test('the index row carries no site bytes', () => {
    const entry = buildLibraryEntry({ hash: 'c'.repeat(40), siteData: siteData(PAGE) });

    // The whole point of a separate store: a keystroke must not pull whole
    // websites back out of IndexedDB.
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes('console.log'), 'file contents stay in the site record');
    assert.ok(serialized.length < 2000, `an index row stays small: ${serialized.length} bytes`);
});

const LIBRARY = [
    buildLibraryEntry({ hash: '1'.repeat(40), siteData: siteData(PAGE), timestamp: 3 }),
    buildLibraryEntry({
        hash: '2'.repeat(40),
        siteData: siteData('<html><head><title>Bakery hours</title></head></html>'),
        signatureState: { publisher: '0xfeed000000000000000000000000000000000002', verified: false },
        timestamp: 2
    }),
    buildLibraryEntry({
        hash: '3'.repeat(40),
        siteData: {
            'index.html': { content: encode('<html><head><title>Club night</title></head></html>'), size: 50 },
            'photography.html': { content: encode('x'), size: 1 }
        },
        timestamp: 1
    })
];

test('an empty query lists everything, newest first', () => {
    assert.deepEqual(
        searchLibrary(LIBRARY, '').map((entry) => entry.title),
        ["Mara's Darkroom", 'Bakery hours', 'Club night']
    );
});

test('a title match outranks a file-name match', () => {
    const results = searchLibrary(LIBRARY, 'photography');

    assert.equal(results.length, 2);
    assert.equal(results[0].title, "Mara's Darkroom", 'the site that is about it comes before the one that mentions it');
});

test('a second word narrows the result', () => {
    assert.equal(searchLibrary(LIBRARY, 'club').length, 1);
    assert.equal(searchLibrary(LIBRARY, 'club photography').length, 1);
    assert.equal(searchLibrary(LIBRARY, 'club bakery').length, 0, 'terms are ANDed, not ORed');
});

test('a hash prefix finds the site it belongs to', () => {
    const results = searchLibrary(LIBRARY, '2222222222');

    assert.equal(results.length, 1);
    assert.equal(results[0].hash, '2'.repeat(40));
});

test('the publisher address is searchable', () => {
    const results = searchLibrary(LIBRARY, '0xfeed');

    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Bakery hours');
});

test('searching is case-insensitive and ignores stray whitespace', () => {
    assert.equal(searchLibrary(LIBRARY, '  DARKroom  ').length, 1);
});
