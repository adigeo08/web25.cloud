/**
 * Markup and stylesheet contracts behind the phone layout.
 *
 * The behaviour itself is CSS and a few lines of inline script, so what can be
 * checked here is the structure they depend on: the burger's wiring, the search
 * field wrapper that lets the pill stack, the single-row stepper selectors, and
 * where the recipient search sits in the messenger panel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const STYLES = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('the burger button is wired to the tab list it opens', () => {
    assert.match(MARKUP, /id="nav-toggle"/);
    assert.match(MARKUP, /aria-controls="primary-nav"/);
    assert.match(MARKUP, /<nav id="primary-nav" class="tab-nav"/);
    // Collapsed only on a phone: the desktop rule set never hides the strip.
    assert.match(STYLES, /@media \(max-width: 720px\) \{[\s\S]*?\.tab-nav \{[\s\S]*?display: none;/);
    assert.match(STYLES, /\.tab-nav\.is-open \{/);
    assert.match(STYLES, /\.nav-burger \{[\s\S]*?display: none;/);
});

test('the gateway search keeps its icon and input in one shrinkable row', () => {
    // The wrapper is what lets the pill become a stacked field on a phone
    // without the absolutely positioned icon drifting off its row.
    const group = MARKUP.slice(MARKUP.indexOf('class="hash-input-group gateway-input-group"'), MARKUP.indexOf('gateway-formats'));
    assert.match(group, /<div class="gateway-field">[\s\S]*?gateway-search-icon[\s\S]*?id="hash-input"[\s\S]*?<\/div>/);
    assert.match(group, /id="load-site"/);
    assert.match(STYLES, /@media \(max-width: 720px\) \{[\s\S]*?\.gateway-input-group \{[\s\S]*?flex-direction: column;/);
});

test('the phone stepper shows only the step before, the current one and the next', () => {
    const phone = STYLES.slice(STYLES.indexOf('@media (max-width: 720px)'));
    // Everything hidden, then exactly three brought back — the current one in
    // the middle column of a 1fr/auto/1fr grid, so it stays centred even when
    // there is no previous or next step.
    assert.match(phone, /\.step-chip \{[\s\S]*?display: none;/);
    assert.match(phone, /\.step-chip\.is-current \{[\s\S]*?grid-column: 2;/);
    assert.match(phone, /\.step-chip:has\(\+ \.step-chip\.is-current\) \{[\s\S]*?grid-column: 1;/);
    assert.match(phone, /\.step-chip\.is-current \+ \.step-chip \{[\s\S]*?grid-column: 3;/);
});

test('the recipient search leads the messenger panel, ahead of the explanation', () => {
    const panel = MARKUP.slice(MARKUP.indexOf('id="dm-choose-role"'), MARKUP.indexOf('SUB-PANEL 2'));
    const title = panel.indexOf('<h3>💬 Direct Messenger</h3>');
    const search = panel.indexOf('class="dm-search"');
    const lede = panel.indexOf('class="dm-lede"');

    assert.ok(title > -1 && search > title, 'the search follows the panel title');
    assert.ok(search < lede, 'the search comes before the explanatory copy');
    // Position only — the field, its button and the result block are unchanged.
    assert.match(panel, /id="dm-recipient-npub-input"/);
    assert.match(panel, /id="dm-nostr-search-btn"/);
    assert.match(panel, /id="dm-search-result"/);
});
