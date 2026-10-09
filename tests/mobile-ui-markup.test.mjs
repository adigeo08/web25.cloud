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

test('the address field gets its own line, with Paste and Search sharing the next', () => {
    // An address is long: the field takes the row, the two actions split the
    // one under it, and on a phone Request chat spans its row too.
    assert.match(STYLES, /\.dm-search \.hash-input-group \.hash-input \{\s*flex: 1 1 100%;/);
    assert.match(STYLES, /\.dm-search \.hash-input-group \.btn \{\s*flex: 1 1 0;/);
    const phone = STYLES.slice(STYLES.lastIndexOf('@media (max-width: 640px)'));
    assert.match(phone, /#channels-nostr-invite-btn \{[\s\S]*?width: 100%;/);
    // Your own address heads the chat list, ahead of the way to start a chat.
    assert.match(MARKUP, /id="dm-copy-own-npub-btn"[\s\S]*?id="dm-nostr-search-btn"/);
});

test('the welcome screen is the exchange: your address, then theirs, then what happens next', () => {
    const panel = MARKUP.slice(MARKUP.indexOf('id="dm-choose-role"'), MARKUP.indexOf('SUB-PANEL 2'));
    const mine = panel.indexOf('id="dm-my-address-card"');
    const theirs = panel.indexOf('class="dm-search"');
    const next = panel.indexOf('class="dm-lede"');
    assert.ok(mine > -1 && mine < theirs && theirs < next, `order: ${mine}, ${theirs}, ${next}`);

    // Yours: whole, grouped, with Copy and (where the platform has one) Share.
    assert.match(panel, /id="dm-welcome-npub" class="dm-address-chunks"/);
    assert.match(panel, /id="dm-welcome-copy-btn"/);
    assert.match(panel, /id="dm-welcome-share-btn"[^>]*class="[^"]*hidden/);
    // Theirs: a Paste button, hidden until the browser can read the clipboard.
    assert.match(panel, /id="dm-paste-btn"[^>]*class="[^"]*hidden/);
});

test('your whole address and the peer’s are one tap away, in a native dialog', () => {
    assert.match(MARKUP, /<dialog id="dm-address-sheet" class="dm-sheet"/);
    assert.match(MARKUP, /<form method="dialog" class="dm-sheet-card">/);
    // Copy is where focus lands; Copy and Share must not submit the form.
    assert.match(MARKUP, /id="dm-sheet-copy" type="button"[^>]*autofocus/);
    assert.match(MARKUP, /id="dm-sheet-share" type="button"/);
    assert.match(MARKUP, /id="dm-show-address-btn"[^>]*aria-label="Show my whole address"/);
    // The peer in the conversation header is the button that opens theirs.
    const head = MARKUP.slice(MARKUP.indexOf('class="dm-chat-head"'), MARKUP.indexOf('id="channels-messages"'));
    assert.match(
        head,
        /<button\s+id="dm-peer-info-btn"[\s\S]*?id="dm-peer-avatar"[\s\S]*?id="dm-connection-status"[\s\S]*?<\/button>/
    );
    // A dialog is centred by margin: auto, which the global reset would zero.
    assert.match(STYLES, /\.dm-sheet \{[\s\S]*?margin: auto;/);
});

test('until it can send, the thread shows the connection step by step', () => {
    const thread = MARKUP.slice(MARKUP.indexOf('class="dm-thread"'), MARKUP.indexOf('id="channels-messages"'));
    assert.match(thread, /id="dm-connect" class="dm-connect hidden" aria-live="polite"/);
    const steps = [...thread.matchAll(/data-step="([a-z]+)"/g)].map((match) => match[1]);
    assert.deepEqual(steps, ['request', 'accept', 'secure']);
    assert.match(thread, /id="dm-connect-presence"/);
    assert.match(thread, /id="dm-connect-cancel"/);
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

test('your address is one line with a copy button that survives its own flash', () => {
    // The address is truncated to a line, like a profile row in a chat list;
    // the whole value is still the element's text, which is what gets copied.
    assert.match(STYLES, /\.dm-own-pubkey-value \{[\s\S]*?white-space: nowrap;[\s\S]*?text-overflow: ellipsis;/);

    // The copy flash swaps the button's text and puts it back as plain text,
    // so the button holds plain text only — and says what it does in
    // `aria-label`, since "Copy" alone does not.
    assert.match(MARKUP, /id="dm-copy-own-npub-btn"[\s\S]{0,300}aria-label="Copy my Nostr address"/);
    assert.match(MARKUP, /id="dm-copy-own-npub-btn"[^>]*>📋 Copy<\/button>/);

    // Order on the list screen: who you are, the filter, invitations, then
    // the contacts.
    const aside = MARKUP.slice(MARKUP.indexOf('class="dm-contacts"'), MARKUP.indexOf('class="dm-main"'));
    const order = ['dm-my-npub-panel', 'dm-contacts-filter', 'dm-invitations', 'dm-contacts-list'].map((id) =>
        aside.indexOf(`id="${id}"`)
    );
    assert.ok(
        order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1])),
        `sidebar order: ${order}`
    );

    // On a phone the list is part of the page scroll, not a box inside it.
    const phone = STYLES.slice(STYLES.indexOf('@media (max-width: 860px)'));
    assert.match(phone, /\.dm-sidebar-scroll,\s*#dm-choose-role \{\s*overflow: visible;/);
});

test('a conversation takes the whole screen on a phone, and desktop keeps both panes', () => {
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

    // The whole screen, not just the tab — and only while the conversation is
    // the pane on show.
    assert.match(
        phone,
        /#tab-channels \.quick-upload\.dm-app:has\(#dm-chat-active:not\(\.hidden\)\):not\(:has\(\.dm-show-contacts\)\) \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;/
    );

    // Desktop: list and conversation side by side.
    assert.match(
        STYLES,
        /\.dm-layout \{\s*display: grid;\s*grid-template-columns: minmax\(270px, 340px\) minmax\(0, 1fr\);/
    );

    // Back leads the conversation head, ahead of the avatar and the peer name;
    // Save and Disconnect sit in the head too, not under the composer.
    const head = MARKUP.slice(MARKUP.indexOf('class="dm-chat-head"'), MARKUP.indexOf('id="channels-messages"'));
    assert.ok(head.indexOf('dm-back-to-contacts') < head.indexOf('id="dm-peer-avatar"'));
    assert.ok(head.indexOf('id="dm-peer-avatar"') < head.indexOf('dm-connection-status'));
    assert.match(head, /id="dm-save-contact-btn"[\s\S]*?id="channels-leave-btn"/);
});

test('the thread is a log with a composer pinned under it, and files live in the thread', () => {
    const chat = MARKUP.slice(MARKUP.indexOf('id="dm-chat-active"'), MARKUP.indexOf('── BROWSE TAB ──'));
    assert.match(chat, /id="channels-messages"[\s\S]{0,120}role="log"/);
    assert.match(
        chat,
        /class="dm-composer"[\s\S]*?id="channels-attach-btn"[\s\S]*?id="channels-message-input"[\s\S]*?id="channels-send-btn"/
    );
    // The old strip of file chips under the composer is gone: transfers are
    // bubbles in the thread.
    assert.ok(!MARKUP.includes('id="channels-files"'));
    // Icon-only controls still have names.
    for (const id of ['channels-attach-btn', 'channels-send-btn', 'dm-back-to-contacts', 'dm-scroll-bottom']) {
        assert.match(chat, new RegExp(`id="${id}"[^>]*aria-label="`), `${id} has an accessible name`);
    }
    // The thread scrolls inside the window instead of growing the page.
    assert.match(STYLES, /\.channels-messages \{[\s\S]*?flex: 1 1 auto;[\s\S]*?overflow-y: auto;/);
});

test('the search toggle offers the local cached history, by that name', () => {
    assert.match(MARKUP, /<span class="gateway-mode-text">Search local cached history<\/span>/);
    assert.ok(!MARKUP.includes('Search sites I have opened'), 'the old wording is gone');
});
