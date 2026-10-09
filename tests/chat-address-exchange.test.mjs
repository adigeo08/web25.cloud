/**
 * Exchanging addresses in the messenger.
 *
 * An address reaches the other person through some other app and comes back
 * pasted, so the finder has to recognise it inside whatever it arrived in —
 * a `nostr:` link, a share-sheet sentence, the groups this page shows it in —
 * and say early when a paste was cut off. And the address shown for reading
 * has to copy back as exactly the address, however it is laid out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom } from './helpers/fake-dom.mjs';
import { npubEncode } from '../src/nostr/nip19.js';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

const NPUB = npubEncode('ab'.repeat(32));
const HEX = 'cd'.repeat(32);

const panel = () => import('../src/ui/channels/ChannelsPanel.js');

test('a bare npub, a nostr: link and a share-sheet sentence all yield the npub', async () => {
    const { extractNostrAddress } = await panel();
    assert.equal(extractNostrAddress(NPUB), NPUB);
    assert.equal(extractNostrAddress(`nostr:${NPUB}`), NPUB);
    assert.equal(extractNostrAddress(`Chat with me on WEB25 — my Nostr address:\n${NPUB}\n\nOpen Chat…`), NPUB);
    assert.equal(
        extractNostrAddress(`  ${NPUB.toUpperCase()}  `),
        NPUB,
        'an all-caps bech32 string is the same address'
    );
});

test('an address split into groups or across lines is put back together', async () => {
    const { extractNostrAddress } = await panel();
    const grouped = NPUB.match(/.{1,5}/g).join(' ');
    assert.equal(extractNostrAddress(grouped), NPUB);
    assert.equal(extractNostrAddress(`${NPUB.slice(0, 30)}\n${NPUB.slice(30)}`), NPUB);
});

test('a hex key passes through, and text with no address is only trimmed', async () => {
    const { extractNostrAddress } = await panel();
    assert.equal(extractNostrAddress(` ${HEX.toUpperCase()} `), HEX);
    assert.equal(extractNostrAddress(`0x${HEX}`), `0x${HEX}`);
    // Left for the real validator to explain, not silently changed.
    assert.equal(extractNostrAddress('  hello there  '), 'hello there');
    assert.equal(extractNostrAddress(''), '');
});

test('the field says what a paste looks like before anything is searched', async () => {
    const { describeAddressInput } = await panel();
    assert.equal(describeAddressInput(NPUB).tone, 'ok');
    assert.equal(describeAddressInput(`nostr:${NPUB}`).tone, 'ok');
    assert.equal(describeAddressInput(HEX).tone, 'ok');

    const cut = describeAddressInput(NPUB.slice(0, 40));
    assert.equal(cut.tone, 'warn');
    assert.match(cut.text, /63 characters; this one has 40/);

    assert.equal(describeAddressInput('').tone, '');
    assert.equal(describeAddressInput('alice').tone, '');
});

test('grouped display copies as one unbroken address and marks the ends', async () => {
    const dom = installFakeDom({ target: { tag: 'p', id: 'target' } });
    try {
        const { renderAddressChunks } = await panel();
        renderAddressChunks(dom.nodes.target, NPUB);

        // Groups are elements with <wbr> between them: no whitespace anywhere,
        // so the text — and a selection of it — is the address itself.
        assert.equal(dom.nodes.target.textContent, NPUB);
        const groups = dom.nodes.target.children.filter((child) => child.tagName === 'SPAN');
        const breaks = dom.nodes.target.children.filter((child) => child.tagName === 'WBR');
        assert.equal(breaks.length, groups.length - 1);
        assert.equal(groups[0].textContent, 'npub1');
        assert.equal(groups[0].className, 'is-prefix');
        assert.equal(groups[1].className, 'is-edge');
        assert.equal(groups.at(-1).className, 'is-edge');

        renderAddressChunks(dom.nodes.target, '');
        assert.equal(dom.nodes.target.children.length, 0, 'no identity, nothing shown');
    } finally {
        dom.restore();
    }
});
