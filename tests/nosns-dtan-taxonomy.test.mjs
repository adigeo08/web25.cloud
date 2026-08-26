/**
 * The mirrored DTAN taxonomy, checked against the real upstream one.
 *
 * `DTAN_CATEGORIES` is a local copy of DTAN's client-side category tree — a
 * relay does not serve a category list, so there is nothing to fetch at
 * runtime. A local copy can drift, and drift is not cosmetic: a `tcat` DTAN
 * does not recognise matches no filter there, so the entry is published and
 * invisible. That is exactly what the old `tcat:web25.cloud,websites` did, and
 * a one-character difference like `ebook` vs `e-book` fails the same way while
 * looking perfectly reasonable in review.
 *
 * So the upstream tree is transcribed here verbatim and compared path by path.
 *
 * Source: https://github.com/v0l/dtan `src/const.ts`, export `Categories`.
 * Fetched 2026-08-26. Update this table deliberately when upstream changes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DTAN_CATEGORIES,
    listDtanCategories,
    serializeDtanCategory,
    isValidDtanCategory
} from '../src/nosns/NosNSProtocol.js';

/** `[comma-joined tag path, upstream display name]`, in upstream tree order. */
const UPSTREAM = [
    ['video', 'Video'],
    ['video,movie', 'Movies'],
    ['video,movie,dvdr', 'Movies DVDR'],
    ['video,movie,hd', 'HD Movies'],
    ['video,movie,4k', '4k Movies'],
    ['video,tv', 'TV'],
    ['video,tv,hd', 'HD TV'],
    ['video,tv,4k', '4k TV'],
    ['audio', 'Audio'],
    ['audio,music', 'Music'],
    ['audio,music,flac', 'FLAC'],
    ['audio,audio-book', 'Audio Books'],
    ['application', 'Applications'],
    ['application,windows', 'Windows'],
    ['application,mac', 'Mac'],
    ['application,unix', 'UNIX'],
    ['application,ios', 'iOS'],
    ['application,android', 'Android'],
    ['game', 'Games'],
    ['game,pc', 'PC'],
    ['game,mac', 'Mac'],
    ['game,psx', 'PSx'],
    ['game,xbox', 'XBOX'],
    ['game,wii', 'Wii'],
    ['game,ios', 'iOS'],
    ['game,android', 'Android'],
    ['porn', 'Porn'],
    ['porn,movie', 'Movies'],
    ['porn,movie,dvdr', 'Movies DVDR'],
    ['porn,movie,hd', 'HD Movies'],
    ['porn,movie,4k', '4k Movies'],
    ['porn,picture', 'Pictures'],
    ['porn,game', 'Games'],
    ['other', 'Other'],
    ['other,archive', 'Archives'],
    ['other,e-book', 'E-Books'],
    ['other,comic', 'Comics'],
    ['other,picture', 'Pictures']
];

test('every DTAN category path matches upstream, in the same order', () => {
    const ours = listDtanCategories().map((entry) => entry.path.join(','));
    const theirs = UPSTREAM.map(([path]) => path);

    // deepEqual on the whole list rather than per-entry: it catches a missing
    // category, an extra one, and a reordering, not just a renamed tag.
    assert.deepEqual(ours, theirs);
});

test('no category path is missing, extra, or misspelled', () => {
    const ours = new Set(listDtanCategories().map((entry) => entry.path.join(',')));
    const theirs = new Set(UPSTREAM.map(([path]) => path));

    const missing = [...theirs].filter((path) => !ours.has(path));
    const extra = [...ours].filter((path) => !theirs.has(path));

    assert.deepEqual(missing, [], 'these upstream categories are not in the mirror');
    assert.deepEqual(extra, [], 'these are in the mirror but not upstream');
});

test('E-Books uses the upstream tag, not a plausible-looking guess', () => {
    // The specific drift this test was written for: `ebook` is not a DTAN
    // category, so anything filed under it was unbrowsable.
    assert.ok(isValidDtanCategory('tcat:other,e-book'));
    assert.equal(isValidDtanCategory('tcat:other,ebook'), false);
});

test('every upstream path serializes to a tcat: our own validator accepts', () => {
    for (const [path] of UPSTREAM) {
        const tcat = serializeDtanCategory(path.split(','));
        assert.equal(tcat, `tcat:${path}`);
        assert.ok(isValidDtanCategory(tcat), tcat);
    }
});

test('the six upstream top-level categories are present and in order', () => {
    assert.deepEqual(
        DTAN_CATEGORIES.map((entry) => entry.tag),
        UPSTREAM.filter(([path]) => !path.includes(',')).map(([path]) => path)
    );
});

test('display names are local, but every category still has one', () => {
    // Deliberately not asserted equal to upstream: the picker nests options
    // under their parent, so upstream's "4k Movies" inside a "Movies" group
    // would read as "Movies / 4k Movies". The tag is the protocol; the label is
    // presentation, and only the tag has to match.
    for (const entry of listDtanCategories()) {
        assert.ok(entry.label.length > 0, entry.tcat);
        assert.ok(!entry.label.includes('undefined'), entry.tcat);
    }
});
