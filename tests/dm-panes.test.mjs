/**
 * The phone's two panes in the Direct Messenger.
 *
 * Desktop shows the contact list and the conversation side by side, and these
 * tests must not change that: what they pin is the one class that decides which
 * of the two a narrow screen is showing, and that switching between them never
 * touches the conversation itself. Leaving the screen is not leaving the chat —
 * that is what Disconnect is for — so the switch has to be pure navigation.
 *
 * The layout is CSS; its selectors are checked against the stylesheet in
 * `mobile-ui-markup.test.mjs`. This is the state those selectors read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

function installMessengerDom() {
    return installFakeDom({
        layout: { tag: 'div', classes: ['dm-layout'] },
        finder: { tag: 'div', id: 'dm-choose-role' },
        chat: { tag: 'div', id: 'dm-chat-active', classes: ['hidden'] },
        backToContacts: { tag: 'button', id: 'dm-back-to-contacts' },
        backToChat: { tag: 'button', id: 'dm-back-to-chat' }
    });
}

let dom;
let panel;
test.beforeEach(async () => {
    dom = installMessengerDom();
    panel = await import(`../src/ui/channels/ChannelsPanel.js?${Math.random()}`);
});
test.afterEach(() => dom.restore());

test('opening a conversation gives it the screen', () => {
    // Somebody sent back to the list, who is then handed a conversation, is
    // looking at the conversation: that is what they asked for.
    panel.showDmPane('contacts');
    assert.equal(dom.nodes.layout.classList.contains('dm-show-contacts'), true);

    panel.showDmStep('dm-chat-active');

    assert.equal(dom.nodes.chat.classList.contains('hidden'), false);
    assert.equal(dom.nodes.layout.classList.contains('dm-show-contacts'), false);
});

test('going back to the list leaves the conversation open behind it', () => {
    panel.showDmStep('dm-chat-active');

    panel.showDmPane('contacts');

    // The class says which pane is on screen. The conversation pane is still
    // *open* — only CSS decides it is not the one being drawn — so nothing
    // about the connection has changed.
    assert.equal(dom.nodes.layout.classList.contains('dm-show-contacts'), true);
    assert.equal(dom.nodes.chat.classList.contains('hidden'), false, 'the conversation is still open');
});

test('the finder makes no claim on the screen', () => {
    // With no conversation open, both panes simply stack on a phone, so this
    // must not decide anything: the two CSS rules that hide a pane are
    // conditional on a conversation being open, and this is the state where
    // neither applies.
    panel.showDmPane('contacts');
    panel.showDmStep('dm-choose-role');

    assert.equal(dom.nodes.chat.classList.contains('hidden'), true);
    assert.equal(
        dom.nodes.layout.classList.contains('dm-show-contacts'),
        true,
        'showing the finder neither claims the screen nor gives it away'
    );
});

test('a document without the messenger on it is not a crash', () => {
    // `showDmPane` runs from a delegated click and from every step change, so
    // it has to survive being called before the panel exists.
    dom.restore();
    dom = installFakeDom({ nothing: { tag: 'div' } });

    assert.doesNotThrow(() => panel.showDmPane('contacts'));
    assert.doesNotThrow(() => panel.showDmStep('dm-chat-active'));
});
