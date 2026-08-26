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
 * @param {{ onSelect: (contact: any) => void, onFilter: (query: string) => void,
 *           onRename?: (contact: any) => void, onRemove?: (contact: any) => void }} handlers
 */
export function bindContactsPanel({ onSelect, onFilter, onRename, onRemove }) {
    const list = document.getElementById('dm-contacts-list');
    const filter = /** @type {HTMLInputElement|null} */ (document.getElementById('dm-contacts-filter'));

    // Delegated: rows are re-rendered whenever presence or the list changes.
    list?.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);

        const action = target.closest('[data-contact-action]');
        if (action) {
            // Rename and Remove sit inside the row, so they must not also open
            // the conversation the row would otherwise start.
            event.stopPropagation();
            const contact = {
                nostrPublicKey: action.getAttribute('data-contact-key') || '',
                npub: action.getAttribute('data-contact-npub') || '',
                name: action.getAttribute('data-contact-name') || ''
            };
            if (action.getAttribute('data-contact-action') === 'rename') onRename?.(contact);
            else onRemove?.(contact);
            return;
        }

        const row = target.closest('[data-contact-key]');
        if (!row) return;
        onSelect({
            nostrPublicKey: row.getAttribute('data-contact-key') || '',
            npub: row.getAttribute('data-contact-npub') || '',
            name: row.getAttribute('data-contact-name') || ''
        });
    });

    // <div role="button"> needs explicit keyboard activation.
    list?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const target = /** @type {HTMLElement} */ (event.target);
        const row = target.closest('[data-contact-key]');
        if (!row) return;
        event.preventDefault();
        onSelect({
            nostrPublicKey: row.getAttribute('data-contact-key') || '',
            npub: row.getAttribute('data-contact-npub') || '',
            name: row.getAttribute('data-contact-name') || ''
        });
    });

    filter?.addEventListener('input', () => onFilter(filter.value.trim()));
}

/**
 * Show that the list exists but cannot be read right now.
 *
 * Contacts are encrypted to the wallet identity, so a locked wallet genuinely
 * has nothing to display: this is the honest state, not a placeholder.
 */
export function renderContactsLocked() {
    const list = document.getElementById('dm-contacts-list');
    const count = document.getElementById('dm-contacts-count');
    if (count) count.textContent = '—';
    if (!list) return;

    list.textContent = '';
    const locked = document.createElement('p');
    locked.className = 'dm-contacts-empty';
    locked.textContent = 'Trusted contacts are encrypted with your wallet identity. Unlock to see them.';
    list.appendChild(locked);
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
    // A div rather than a button: the row now contains its own Rename and
    // Remove buttons, and a button cannot legally nest buttons.
    const row = document.createElement('div');
    row.className = `dm-contact${contact.nostrPublicKey === selectedKey ? ' is-selected' : ''}`;
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
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
    row.appendChild(renderContactActions(contact));
    return row;
}

/**
 * Rename and Remove.
 *
 * Removing is a local authorization change only: the peer becomes unknown
 * again and a future invitation from them needs approval. No key is deleted or
 * rotated on either side.
 *
 * @param {any} contact
 */
function renderContactActions(contact) {
    const actions = document.createElement('span');
    actions.className = 'dm-contact-actions';

    for (const [action, label, title] of [
        ['rename', '✏️', 'Rename this contact'],
        ['remove', '🗑️', 'Remove this contact. Future invitations from them will need approval again.']
    ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dm-contact-action';
        button.textContent = label;
        button.title = title;
        button.setAttribute('aria-label', title);
        button.setAttribute('data-contact-action', action);
        button.setAttribute('data-contact-key', contact.nostrPublicKey);
        button.setAttribute('data-contact-npub', contact.npub || '');
        button.setAttribute('data-contact-name', contact.name || '');
        actions.appendChild(button);
    }

    return actions;
}

/**
 * Presence shown next to a searched address, before any conversation exists.
 *
 * Presence is a beacon that has to arrive, so there is a real third state: we
 * have subscribed but nothing has come back yet. Showing "offline" during that
 * window would be a guess presented as fact, so it gets its own label.
 *
 * @param {boolean|null|'checking'} online null clears, 'checking' is pending
 */
export function renderSearchPresence(online) {
    const el = document.getElementById('dm-search-result-presence');
    if (!el) return;
    if (online === null) {
        el.textContent = '';
        el.className = 'dm-search-result-presence';
        return;
    }
    if (online === 'checking') {
        el.textContent = '⏳ Checking whether they are online…';
        el.className = 'dm-search-result-presence is-checking';
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
