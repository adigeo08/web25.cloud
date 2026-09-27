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
    const group = MARKUP.slice(
        MARKUP.indexOf('class="hash-input-group gateway-input-group"'),
        MARKUP.indexOf('gateway-formats')
    );
    assert.match(group, /<div class="gateway-field">[\s\S]*?gateway-search-icon[\s\S]*?id="hash-input"[\s\S]*?<\/div>/);
    assert.match(group, /id="load-site"/);
    assert.match(
        STYLES,
        /@media \(max-width: 720px\) \{[\s\S]*?\.gateway-input-group \{[\s\S]*?flex-direction: column;/
    );
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

test('the recipient search button spans the row on a phone, like Copy my address', () => {
    const phone = STYLES.slice(STYLES.lastIndexOf('@media (max-width: 640px)'));
    // The copy button is full width at every size; the search button only needs
    // to be at this one, where its field already takes the whole row and a
    // content-width control under it reads as an afterthought.
    assert.match(STYLES, /\.dm-copy-address-btn \{[\s\S]*?width: 100%;/);
    assert.match(phone, /\.dm-search \.hash-input-group \{[\s\S]*?flex-direction: column;/);
    assert.match(phone, /\.dm-search \.hash-input-group \.btn \{[\s\S]*?width: 100%;/);
    // Both controls live in the messenger panel, which is what makes the
    // mismatch visible in the first place.
    assert.match(MARKUP, /id="dm-copy-own-npub-btn"[\s\S]*?id="dm-nostr-search-btn"/);
});

test('the viewer strip stays one row on a phone, and shrinks instead of wrapping', () => {
    const phone = STYLES.slice(STYLES.indexOf('@media (max-width: 640px)'));
    // Wrapping spent a line of a small screen on chrome above somebody else's
    // page, and stretching the two controls to fill it made them look like the
    // point of the view.
    assert.doesNotMatch(phone.slice(0, 600), /\.site-viewer-header \{[\s\S]{0,200}?flex-wrap: wrap;/);
    assert.match(phone, /\.site-viewer-header \.btn \{[\s\S]*?min-height: 30px;/);
    assert.match(phone, /\.site-viewer-header \.viewer-info \{[\s\S]*?flex-wrap: nowrap;/);

    // Narrower still, the bin stands for "delete" on its own — and the button
    // carries the wording in `aria-label`, so dropping the text costs a screen
    // reader nothing.
    const narrow = STYLES.slice(STYLES.indexOf('@media (max-width: 420px)'));
    assert.match(narrow, /#viewer-forget \.viewer-action-label \{[\s\S]*?display: none;/);
    assert.match(MARKUP, /id="viewer-forget"[\s\S]{0,240}aria-label="Delete this site's data from this browser"/);
    assert.match(MARKUP, /id="viewer-forget"[\s\S]{0,320}<span class="viewer-action-label">Delete data<\/span>/);
});

test('the contacts sidebar becomes a toolbar with a list under it on a phone', () => {
    const phone = STYLES.slice(STYLES.indexOf('@media (max-width: 860px)'));

    // The identity card collapses to the one control that does something, and
    // shares a line with the contact filter.
    assert.match(phone, /#dm-my-npub-panel \{[\s\S]*?display: contents;/);
    assert.match(phone, /\.dm-copy-address-label \{[\s\S]*?display: none;/);
    assert.match(phone, /\.dm-contacts \.dm-copy-address-btn \{[\s\S]*?order: 1;/);
    assert.match(phone, /\.dm-contacts input\.dm-contacts-filter \{[\s\S]*?order: 2;/);
    // Invitations sit under that toolbar, and the list under them.
    assert.match(phone, /#dm-invitations \{[\s\S]*?order: 4;/);
    assert.match(phone, /\.dm-contacts-list \{[\s\S]*?order: 6;/);

    // Hiding the wording needs the button to say it some other way.
    assert.match(MARKUP, /id="dm-copy-own-npub-btn"[\s\S]{0,300}aria-label="Copy my Nostr address"/);
    assert.match(MARKUP, /<span class="dm-copy-address-label">Copy my address<\/span>/);
});

test('a conversation takes the whole tab on a phone, and desktop keeps both panes', () => {
    const phone = STYLES.slice(STYLES.indexOf('@media (max-width: 860px)'));

    // Both rules are conditional on a conversation actually being open, so the
    // finder screen still stacks under the contacts exactly as it did.
    assert.match(
        phone,
        /\.dm-layout:has\(#dm-chat-active:not\(\.hidden\)\):not\(\.dm-show-contacts\) \.dm-contacts \{[\s\S]*?display: none;/
    );
    assert.match(
        phone,
        /\.dm-layout:has\(#dm-chat-active:not\(\.hidden\)\)\.dm-show-contacts \.dm-main \{[\s\S]*?display: none;/
    );

    // The two ways between the panes exist, and are phone-only furniture: on
    // desktop both panes are on screen and there is nothing to switch to.
    assert.match(MARKUP, /id="dm-back-to-contacts"/);
    assert.match(MARKUP, /id="dm-back-to-chat"/);
    assert.match(STYLES, /\.dm-pane-switch \{\s*display: none;/);
    assert.match(
        phone,
        /\.dm-layout:has\(#dm-chat-active:not\(\.hidden\)\) \.dm-back-to-contacts \{[\s\S]*?display: inline-flex;/
    );

    // Back leads the conversation head, ahead of the avatar and the peer name.
    assert.match(phone, /\.dm-back-to-contacts \{[\s\S]*?order: -3;/);
    const head = MARKUP.slice(MARKUP.indexOf('class="dm-chat-head"'), MARKUP.indexOf('id="channels-messages"'));
    assert.ok(head.indexOf('dm-back-to-contacts') < head.indexOf('dm-connection-status'));
});

test('the search toggle offers the local cached history, by that name', () => {
    assert.match(MARKUP, /<span class="gateway-mode-text">Search local cached history<\/span>/);
    assert.ok(!MARKUP.includes('Search sites I have opened'), 'the old wording is gone');
});
