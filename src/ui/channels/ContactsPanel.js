// @ts-check
/**
 * Contact list for the Direct Messenger.
 *
 * Shows who you know, whether they look reachable, and lets you open one. It
 * deliberately cannot start a conversation on its own: selecting a contact
 * expresses intent, and the conversation only begins once that intent is
 * mutual. Presence and conversation are separate states here as everywhere.
 */

import { shortNpub } from '../../nostr/nip19.js';

/**
 * @param {{ onSelect: (contact: any) => void, onFilter: (query: string) => void }} handlers
 */
export function bindContactsPanel({ onSelect, onFilter }) {
    const list = document.getElementById('dm-contacts-list');
    const filter = /** @type {HTMLInputElement|null} */ (document.getElementById('dm-contacts-filter'));

    // Delegated: rows are re-rendered whenever presence or the list changes.
    list?.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const row = target.closest('[data-contact-key]');
        if (!row) return;
        onSelect({
            nostrPublicKey: row.getAttribute('data-contact-key') || '',
            npub: row.getAttribute('data-contact-npub') || '',
            name: row.getAttribute('data-contact-name') || ''
        });
    });

    filter?.addEventListener('input', () => onFilter(filter.value.trim()));
}

/**
 * @param {any[]} contacts
 * @param {{ isOnline?: (pubkey: string) => boolean, selectedKey?: string }} [options]
 */
export function renderContacts(contacts, { isOnline = () => false, selectedKey = '' } = {}) {
    const list = document.getElementById('dm-contacts-list');
    const count = document.getElementById('dm-contacts-count');
    if (count) count.textContent = `${(contacts || []).length}`;
    if (!list) return;

    list.textContent = '';

    if (!contacts || contacts.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'dm-contacts-empty';
        empty.textContent = 'No contacts yet. Search an npub and save them after chatting.';
        list.appendChild(empty);
        return;
    }

    for (const contact of contacts) {
        list.appendChild(renderContactRow(contact, isOnline(contact.nostrPublicKey), selectedKey));
    }
}

/**
 * Everything is written with `textContent`: a friendly name is local, but the
 * identities beside it came from the network.
 *
 * @param {any} contact
 * @param {boolean} online
 * @param {string} selectedKey
 */
function renderContactRow(contact, online, selectedKey) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `dm-contact${contact.nostrPublicKey === selectedKey ? ' is-selected' : ''}`;
    row.setAttribute('data-contact-key', contact.nostrPublicKey);
    row.setAttribute('data-contact-npub', contact.npub || '');
    row.setAttribute('data-contact-name', contact.name || '');

    const dot = document.createElement('span');
    dot.className = `dm-presence-dot${online ? ' is-online' : ''}`;
    dot.setAttribute('aria-label', online ? 'online' : 'offline');

    const body = document.createElement('span');
    body.className = 'dm-contact-body';

    const name = document.createElement('span');
    name.className = 'dm-contact-name';
    name.textContent = contact.name || shortNpub(contact.npub || contact.nostrPublicKey);

    // Enough identity to disambiguate two contacts with the same friendly name.
    const identity = document.createElement('span');
    identity.className = 'dm-contact-identity';
    const evm = contact.evmAddress ? `${contact.evmAddress.slice(0, 8)}…` : 'no EVM address';
    identity.textContent = `${shortNpub(contact.npub || contact.nostrPublicKey)} · ${evm}`;

    body.appendChild(name);
    body.appendChild(identity);
    row.appendChild(dot);
    row.appendChild(body);
    return row;
}

/**
 * Presence shown next to a searched address, before any conversation exists.
 * @param {boolean|null} online null when presence is unknown
 */
export function renderSearchPresence(online) {
    const el = document.getElementById('dm-search-result-presence');
    if (!el) return;
    if (online === null) {
        el.textContent = '';
        el.className = 'dm-search-result-presence';
        return;
    }
    // Being online is not an invitation: say so plainly.
    el.textContent = online
        ? '🟢 Online · they still have to accept before a chat opens'
        : '⚪ Offline · your request will be waiting for them';
    el.className = `dm-search-result-presence${online ? ' is-online' : ''}`;
}

/**
 * @param {(() => void)} onSave
 */
export function bindSaveContact(onSave) {
    const button = document.getElementById('dm-save-contact-btn');
    if (!button || button.dataset.bound) return;
    button.dataset.bound = '1';
    button.addEventListener('click', () => onSave());
}
