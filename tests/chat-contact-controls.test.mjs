/**
 * The controls behind saving, declining and blocking.
 *
 * Markup and rendering contracts: the dialog that replaced window.prompt
 * confirms on Enter, every invitation can be blocked as well as declined, a
 * friend can be blocked from the list, blocked people can be unblocked, and
 * the retention choices offered are exactly the ones the archive accepts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFakeDom } from './helpers/fake-dom.mjs';
import { RETENTION_CHOICES } from '../src/channels/MessageArchive.js';

const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const STYLES = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const PEER = 'c3'.repeat(32);

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

test('the naming dialog confirms on Enter and caps the name like the store does', () => {
    const dialog = MARKUP.slice(MARKUP.indexOf('<dialog id="dm-prompt-dialog"'), MARKUP.indexOf('── BROWSE TAB ──'));
    assert.match(dialog, /<form method="dialog"/);
    // The first submit button is the one Enter presses.
    const confirm = dialog.indexOf('id="dm-prompt-confirm" value="confirm"');
    const cancel = dialog.indexOf('value="cancel"');
    assert.ok(confirm > -1 && cancel > confirm, 'Confirm comes before Cancel in the form');
    assert.match(dialog, /id="dm-prompt-input" type="text" maxlength="64"/);
    // On screen Confirm still sits last.
    assert.match(STYLES, /\.dm-prompt-actions \{[\s\S]*?flex-direction: row-reverse;/);
});

test('the retention choices are exactly what the archive keeps, Off included', () => {
    const offered = [...MARKUP.matchAll(/data-retention="(\d+)"/g)].map((match) => Number(match[1]));
    assert.deepEqual(offered, [...RETENTION_CHOICES]);
    assert.ok(Math.max(...offered) <= 7 * 24 * 60 * 60 * 1000, 'never more than a week');
    assert.match(MARKUP, /<div class="dm-segmented" role="radiogroup"/);
});

test('the contact card has Block, and the list has a Blocked section to undo it', () => {
    assert.match(MARKUP, /id="dm-sheet-block" type="button" class="btn btn-danger dm-sheet-block hidden"/);
    const aside = MARKUP.slice(MARKUP.indexOf('class="dm-contacts"'), MARKUP.indexOf('class="dm-main"'));
    assert.ok(
        aside.indexOf('id="dm-contacts-list"') < aside.indexOf('id="dm-blocked"'),
        'Blocked folds under the list'
    );
    assert.match(
        aside,
        /<section id="dm-blocked" class="dm-blocked hidden"[\s\S]*?<details>[\s\S]*?id="dm-blocked-list"/
    );
});

function invitationsDom() {
    return installFakeDom({
        section: { tag: 'section', id: 'dm-invitations', classes: ['hidden'] },
        list: { tag: 'div', id: 'dm-invitations-list' },
        count: { tag: 'span', id: 'dm-invitations-count' }
    });
}

test('every invitation can be accepted, declined or blocked, and Block carries who it is', async () => {
    const dom = invitationsDom();
    try {
        const { bindInvitationsPanel, renderInvitations } = await import(
            `../src/ui/channels/InvitationsPanel.js?${Math.random()}`
        );
        const calls = [];
        bindInvitationsPanel({
            onAccept: (peer) => calls.push(['accept', peer]),
            onDecline: (peer) => calls.push(['decline', peer]),
            onBlock: (peer, details) => calls.push(['block', peer, details])
        });
        renderInvitations([
            {
                kind: 'request',
                peerNostrPublicKey: PEER,
                npub: 'npub1mallory',
                profileName: 'Mallory',
                trustState: 'unknown'
            }
        ]);

        const buttons = dom.nodes.list.querySelectorAll('button');
        assert.deepEqual(
            buttons.map((button) => button.getAttribute('data-invite-action')),
            ['accept', 'decline', 'block']
        );
        buttons[2].click();
        assert.deepEqual(calls, [['block', PEER, { name: 'Mallory', npub: 'npub1mallory' }]]);
    } finally {
        dom.restore();
    }
});

test('a contact row carries Block beside Copy, Rename and Remove, with "⋯" for touch screens', async () => {
    const dom = installFakeDom({
        list: { tag: 'div', id: 'dm-contacts-list' },
        count: { tag: 'span', id: 'dm-contacts-count' }
    });
    try {
        const { bindContactsPanel, renderContacts } = await import(
            `../src/ui/channels/ContactsPanel.js?${Math.random()}`
        );
        const calls = [];
        bindContactsPanel({
            onSelect: (contact) => calls.push(['select', contact.nostrPublicKey]),
            onFilter: () => {},
            onBlock: (contact) => calls.push(['block', contact.nostrPublicKey, contact.name])
        });
        renderContacts([{ nostrPublicKey: PEER, npub: 'npub1alice', name: 'Alice', evmAddress: '0x1234567890' }]);

        const actions = dom.nodes.list.querySelectorAll('[data-contact-action]');
        assert.deepEqual(
            actions.map((button) => button.getAttribute('data-contact-action')),
            ['more', 'copy', 'rename', 'remove', 'block']
        );

        actions[4].dispatch('click', { stopPropagation() {} });
        assert.deepEqual(calls, [['block', PEER, 'Alice']], 'Block does not also open the conversation');

        // "⋯" opens the row's actions, and says so.
        actions[0].dispatch('click', { stopPropagation() {} });
        const row = dom.nodes.list.querySelector('.dm-contact');
        assert.equal(row.classList.contains('is-actions-open'), true);
        assert.equal(actions[0].getAttribute('aria-expanded'), 'true');
        assert.equal(calls.length, 1, '"⋯" opens nothing else');
    } finally {
        dom.restore();
    }
});

test('the Blocked list shows who is blocked and unblocks them on request', async () => {
    const dom = installFakeDom({
        section: { tag: 'section', id: 'dm-blocked', classes: ['hidden'] },
        list: { tag: 'div', id: 'dm-blocked-list' },
        count: { tag: 'span', id: 'dm-blocked-count' }
    });
    try {
        const { bindContactsPanel, renderBlockedContacts } = await import(
            `../src/ui/channels/ContactsPanel.js?${Math.random()}`
        );
        const calls = [];
        bindContactsPanel({ onSelect: () => {}, onFilter: () => {}, onUnblock: (entry) => calls.push(entry) });

        renderBlockedContacts([]);
        assert.equal(dom.nodes.section.classList.contains('hidden'), true, 'no section while nobody is blocked');

        renderBlockedContacts([{ nostrPublicKey: PEER, npub: 'npub1mallory', name: '<b>Mallory</b>' }]);
        assert.equal(dom.nodes.section.classList.contains('hidden'), false);
        assert.equal(dom.nodes.count.textContent, '1');
        assert.ok(dom.nodes.list.textContent.includes('<b>Mallory</b>'), 'a name is text, never markup');

        dom.nodes.list.querySelector('[data-unblock-key]').click();
        assert.deepEqual(calls, [{ nostrPublicKey: PEER, name: '<b>Mallory</b>' }]);
    } finally {
        dom.restore();
    }
});
