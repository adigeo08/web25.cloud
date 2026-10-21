/**
 * The New connection sheet (acceptance criterion 10).
 *
 * The button beside Copy — the one that used to show only your address — now
 * opens the whole new-chat flow in a dialog: your address, the field for
 * theirs, and what happens next. Closing it, however it closes, touches no
 * conversation; a successful request closes it and opens the conversation.
 * Escape and focus are the native dialog's own (the markup is pinned in
 * mobile-ui-markup.test.mjs, and the browser smoke test presses Escape).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFakeDom } from './helpers/fake-dom.mjs';

const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function installSheetDom() {
    const dom = installFakeDom({
        newChatButton: { tag: 'button', id: 'dm-show-address-btn' },
        sheet: { tag: 'dialog', id: 'dm-new-chat-sheet' },
        input: { tag: 'input', id: 'dm-recipient-npub-input' },
        search: { tag: 'button', id: 'dm-nostr-search-btn' },
        hint: { tag: 'p', id: 'dm-search-hint' },
        result: { tag: 'div', id: 'dm-search-result', classes: ['hidden'] },
        request: { tag: 'button', id: 'channels-nostr-invite-btn' },
        error: { tag: 'p', id: 'dm-choose-role-error', classes: ['hidden'] },
        empty: { tag: 'div', id: 'dm-empty' },
        chat: { tag: 'div', id: 'dm-chat-active', classes: ['hidden'] },
        leave: { tag: 'button', id: 'channels-leave-btn' }
    });
    const sheet = dom.nodes.sheet;
    sheet.open = false;
    sheet.opened = 0;
    sheet.showModal = function () {
        this.open = true;
        this.opened += 1;
    };
    sheet.close = function () {
        if (!this.open) return;
        this.open = false;
        this.dispatch('close');
    };
    dom.nodes.input.value = '';
    return dom;
}

async function settle() {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const NPUB = 'npub1' + 'q'.repeat(58);

async function bindPanel(dom, { startChat = async () => true } = {}) {
    const panel = await import(`../src/ui/channels/ChannelsPanel.js?${Math.random()}`);
    const calls = { closed: 0, left: 0, started: [] };
    panel.bindChannelsPanel({
        onSearch: async (query) => ({ nostrPublicKey: 'f'.repeat(64), npub: query, shortNpub: 'npub1…', profile: null }),
        onStartChat: async (result) => {
            calls.started.push(result);
            return startChat(result);
        },
        onLeave: () => {
            calls.left += 1;
        },
        onSend: () => {},
        onCloseNewChat: () => {
            calls.closed += 1;
        }
    });
    return { panel, calls };
}

test('the existing button opens the New connection sheet', async () => {
    const dom = installSheetDom();
    try {
        await bindPanel(dom);
        dom.nodes.newChatButton.click();
        assert.equal(dom.nodes.sheet.open, true);
        assert.equal(dom.nodes.sheet.opened, 1);
    } finally {
        dom.restore();
    }
});

test('a tap on the backdrop closes it, and closing touches no conversation', async () => {
    const dom = installSheetDom();
    try {
        const { calls } = await bindPanel(dom);
        dom.nodes.newChatButton.click();
        // The dialog itself is the target only when the backdrop is hit.
        dom.nodes.sheet.dispatch('click', { target: dom.nodes.sheet });
        assert.equal(dom.nodes.sheet.open, false);
        assert.equal(calls.closed, 1, 'the searched address stops being watched');
        assert.equal(calls.left, 0, 'the open conversation stays open');

        // A click inside the sheet is not the backdrop.
        dom.nodes.newChatButton.click();
        dom.nodes.sheet.dispatch('click', { target: dom.nodes.input });
        assert.equal(dom.nodes.sheet.open, true);
    } finally {
        dom.restore();
    }
});

test('a successful request closes the sheet and opens the conversation', async () => {
    const dom = installSheetDom();
    try {
        const { calls } = await bindPanel(dom);
        dom.nodes.newChatButton.click();
        dom.nodes.input.value = NPUB;
        dom.nodes.search.click();
        await settle();
        dom.nodes.request.click();
        await settle();

        assert.equal(calls.started.length, 1);
        assert.equal(dom.nodes.sheet.open, false, 'the sheet has done its job');
        assert.equal(dom.nodes.chat.classList.contains('hidden'), false, 'the conversation is on screen');
        assert.equal(dom.nodes.empty.classList.contains('hidden'), true);
        assert.equal(calls.left, 0);
    } finally {
        dom.restore();
    }
});

test('a request that does not go through leaves the sheet open', async () => {
    const dom = installSheetDom();
    try {
        await bindPanel(dom, { startChat: async () => false });
        dom.nodes.newChatButton.click();
        dom.nodes.input.value = NPUB;
        dom.nodes.search.click();
        await settle();
        dom.nodes.request.click();
        await settle();
        assert.equal(dom.nodes.sheet.open, true);
        assert.equal(dom.nodes.chat.classList.contains('hidden'), true);
    } finally {
        dom.restore();
    }
});

test('closing a conversation lands on the quiet empty state, not the onboarding', async () => {
    const dom = installSheetDom();
    try {
        const { panel, calls } = await bindPanel(dom);
        panel.showDmStep('dm-chat-active');
        dom.nodes.leave.click();
        assert.equal(calls.left, 1);
        assert.equal(dom.nodes.empty.classList.contains('hidden'), false);
        assert.equal(dom.nodes.sheet.open, false, 'the sheet does not pop up on its own');
    } finally {
        dom.restore();
    }
});

test('the sheet holds all three sections, and no second address flow exists', () => {
    const start = MARKUP.indexOf('<dialog id="dm-new-chat-sheet"');
    const sheet = MARKUP.slice(start, MARKUP.indexOf('</dialog>', start));
    // 1. Your address · 2. Start a new chat · 3. What happens next.
    const one = sheet.indexOf('<span>1</span> Your address');
    const two = sheet.indexOf('<span>2</span> Start a new chat');
    const three = sheet.indexOf('<span>3</span>');
    assert.ok(one > -1 && two > one && three > two, `sections in order: ${one}, ${two}, ${three}`);
    for (const id of [
        'dm-welcome-npub',
        'dm-welcome-copy-btn',
        'dm-welcome-share-btn',
        'dm-recipient-npub-input',
        'dm-paste-btn',
        'dm-nostr-search-btn',
        'dm-search-result',
        'channels-nostr-invite-btn'
    ]) {
        assert.ok(sheet.includes(`id="${id}"`), `${id} lives in the sheet`);
    }

    // The main pane keeps only the empty state and the conversation.
    const main = MARKUP.slice(MARKUP.indexOf('<div class="dm-main">'), MARKUP.indexOf('── BROWSE TAB ──'));
    const mainPane = main.slice(0, main.indexOf('<dialog'));
    assert.ok(mainPane.includes('id="dm-empty"'));
    assert.ok(!mainPane.includes('id="dm-choose-role"'), 'onboarding is not on the main screen');

    // One New connection button: the old address button, relabelled.
    assert.equal(MARKUP.match(/id="dm-show-address-btn"/g).length, 1);
    assert.ok(!MARKUP.includes('Show my whole address'));
});
