/**
 * The NosNS convention itself: the one relay, the mirrored DTAN taxonomy, and
 * the torrent-name suffix that is the entire discriminator.
 *
 * Everything here is pure configuration and string handling, which is the
 * point: NosNS adds no custom kind, no custom category and no custom tag, so
 * there is nothing else to test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NOSNS_RELAY,
    NOSNS_RELAYS,
    NOSNS_TORRENT_SUFFIX,
    NOSNS_EVENT_KIND,
    NOSNS_DEFAULT_CATEGORY,
    DTAN_CATEGORIES,
    ensureNosnsTorrentName,
    isNosnsTorrentName,
    nosnsDisplayName,
    listDtanCategories,
    serializeDtanCategory,
    parseDtanCategory,
    isValidDtanCategory,
    dtanCategoryLabel,
    normalizeDtanCategory
} from '../src/nosns/NosNSProtocol.js';

// ─── 1. The relay ────────────────────────────────────────────────────────

test('the NosNS relay list is exactly one relay', () => {
    assert.equal(NOSNS_RELAY, 'wss://relay.dtan.xyz');
    assert.deepEqual([...NOSNS_RELAYS], ['wss://relay.dtan.xyz']);
    assert.equal(NOSNS_RELAYS.length, 1);
});

test('no generic relay is smuggled into the directory list', () => {
    for (const relay of ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band', 'wss://relay.snort.social']) {
        assert.ok(!NOSNS_RELAYS.includes(relay), `${relay} must not be a NosNS directory relay`);
    }
});

test('the DM relay configuration is untouched by NosNS', async () => {
    const { DEFAULT_NOSTR_DM_RELAYS, DEFAULT_NOSTR_RELAYS } = await import('../src/config/nostr.config.js');

    // The DM pool keeps its own redundancy; the directory does not borrow it
    // and does not shrink it.
    assert.equal(DEFAULT_NOSTR_DM_RELAYS, DEFAULT_NOSTR_RELAYS);
    assert.ok(DEFAULT_NOSTR_DM_RELAYS.length >= 4);
    assert.ok(!DEFAULT_NOSTR_DM_RELAYS.includes(NOSNS_RELAY));
});

test('NosNS uses the standard NIP-35 kind, not a custom one', () => {
    assert.equal(NOSNS_EVENT_KIND, 2003);
});

// ─── 2. The DTAN taxonomy ────────────────────────────────────────────────

test('the mirrored taxonomy has DTAN\'s six top-level categories', () => {
    assert.deepEqual(
        DTAN_CATEGORIES.map((entry) => entry.tag),
        ['video', 'audio', 'application', 'game', 'porn', 'other']
    );
});

test('the documented category examples serialize exactly as DTAN expects', () => {
    assert.equal(serializeDtanCategory(['application']), 'tcat:application');
    assert.equal(serializeDtanCategory(['application', 'unix']), 'tcat:application,unix');
    assert.equal(serializeDtanCategory(['other', 'archive']), 'tcat:other,archive');
    assert.equal(serializeDtanCategory(['video', 'movie', '4k']), 'tcat:video,movie,4k');
});

test('parsing is the inverse of serializing', () => {
    for (const tcat of listDtanCategories().map((entry) => entry.tcat)) {
        assert.equal(serializeDtanCategory(parseDtanCategory(tcat)), tcat);
    }
});

test('every listed category validates, and nothing else does', () => {
    for (const { tcat } of listDtanCategories()) assert.ok(isValidDtanCategory(tcat), tcat);

    // The invented category that made the old registry invisible in DTAN.
    assert.equal(isValidDtanCategory('tcat:web25.cloud,websites'), false);
    assert.equal(isValidDtanCategory('tcat:nosns'), false);
    assert.equal(isValidDtanCategory('tcat:'), false);
    assert.equal(isValidDtanCategory(''), false);
    assert.equal(isValidDtanCategory('application'), false, 'the tcat: prefix is required');
});

test('an unknown category normalizes to the default rather than leaking through', () => {
    assert.equal(normalizeDtanCategory('tcat:web25.cloud,websites'), NOSNS_DEFAULT_CATEGORY);
    assert.equal(normalizeDtanCategory(''), NOSNS_DEFAULT_CATEGORY);
    assert.equal(normalizeDtanCategory('tcat:other,archive'), 'tcat:other,archive');
    assert.equal(normalizeDtanCategory('TCAT:Other,Archive'), 'tcat:other,archive');
});

test('labels read as a human path through the tree', () => {
    assert.equal(dtanCategoryLabel('tcat:application'), 'Applications');
    assert.equal(dtanCategoryLabel('tcat:application,unix'), 'Applications / UNIX');
    assert.equal(dtanCategoryLabel('tcat:other,archive'), 'Other / Archives');
    assert.equal(dtanCategoryLabel('tcat:video,movie,4k'), 'Video / Movies / 4k');
});

test('the taxonomy is frozen configuration, not something a relay supplies', () => {
    assert.ok(Object.isFrozen(DTAN_CATEGORIES));
    // Categories load with no network at all — this whole file makes no
    // connection, which is exactly why the picker works while DTAN is down.
    assert.ok(listDtanCategories().length > 30);
});

test('the default category is a real DTAN category', () => {
    assert.equal(NOSNS_DEFAULT_CATEGORY, 'tcat:application');
    assert.ok(isValidDtanCategory(NOSNS_DEFAULT_CATEGORY));
});

// ─── 3. Torrent naming ───────────────────────────────────────────────────

test('the suffix is exactly the documented one', () => {
    assert.equal(NOSNS_TORRENT_SUFFIX, '.nosns.torrent');
});

test('naming is idempotent across the documented inputs', () => {
    assert.equal(ensureNosnsTorrentName('my-site'), 'my-site.nosns.torrent');
    assert.equal(ensureNosnsTorrentName('my-site.torrent'), 'my-site.nosns.torrent');
    assert.equal(ensureNosnsTorrentName('my-site.nosns.torrent'), 'my-site.nosns.torrent');
});

test('applying the helper twice changes nothing', () => {
    for (const input of ['my-site', 'my-site.torrent', 'my-site.nosns.torrent', 'Site With Spaces']) {
        const once = ensureNosnsTorrentName(input);
        assert.equal(ensureNosnsTorrentName(once), once, input);
        assert.equal(ensureNosnsTorrentName(ensureNosnsTorrentName(once)), once, input);
    }
});

test('a differently cased suffix is normalized, never stacked', () => {
    assert.equal(ensureNosnsTorrentName('my-site.NOSNS.TORRENT'), 'my-site.nosns.torrent');
    assert.equal(ensureNosnsTorrentName('my-site.Torrent'), 'my-site.nosns.torrent');
});

test('an empty or whitespace name still produces a valid NosNS name', () => {
    assert.equal(ensureNosnsTorrentName(''), 'website.nosns.torrent');
    assert.equal(ensureNosnsTorrentName('   '), 'website.nosns.torrent');
    assert.equal(ensureNosnsTorrentName('.torrent'), 'website.nosns.torrent');
    assert.ok(isNosnsTorrentName(ensureNosnsTorrentName(undefined)));
});

test('the suffix check is the whole NosNS protocol check', () => {
    assert.equal(isNosnsTorrentName('example.nosns.torrent'), true);
    assert.equal(isNosnsTorrentName('EXAMPLE.NOSNS.TORRENT'), true);
    assert.equal(isNosnsTorrentName('example.torrent'), false);
    assert.equal(isNosnsTorrentName('example.nosns'), false);
    assert.equal(isNosnsTorrentName('nosns.torrent.example'), false);
    assert.equal(isNosnsTorrentName(''), false);
});

test('display names drop the suffix but leave other names alone', () => {
    assert.equal(nosnsDisplayName('example-site.nosns.torrent'), 'example-site');
    assert.equal(nosnsDisplayName('Some Linux ISO'), 'Some Linux ISO');
    assert.equal(nosnsDisplayName(''), '');
});
