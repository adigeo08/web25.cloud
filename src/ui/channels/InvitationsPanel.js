// @ts-check
/**
 * Pending chat invitations.
 *
 * The visible half of the consent model: an invitation from a peer who is not
 * an approved contact appears here and waits. Nothing is answered, no ICE is
 * gathered and the local ECIES key and EVM identity are not revealed until
 * somebody presses Accept.
 *
 * Two kinds arrive. A `request` is somebody asking to talk, and carries only
 * their npub — it is how first contact happens. An `offer` is a full WebRTC
 * invitation and carries the sender's EVM identity, which the row shows.
 *
 * Every field shown came off a public relay, so all of it is written with
 * `textContent` and nothing is interpreted as markup.
 */

import { shortNpub } from '../../nostr/nip19.js';

const TRUST_LABELS = {
    unknown: { text: 'Unknown sender', className: 'dm-invite-trust is-unknown' },
    pending: { text: 'Awaiting your decision', className: 'dm-invite-trust is-unknown' },
    blocked: { text: 'Previously declined', className: 'dm-invite-trust is-blocked' },
    trusted: { text: 'Trusted contact', className: 'dm-invite-trust is-trusted' }
};

/**
 * @param {{ onAccept: (peerNostrPublicKey: string) => void,
 *           onDecline: (peerNostrPublicKey: string) => void }} handlers
 */
export function bindInvitationsPanel({ onAccept, onDecline }) {
    const list = document.getElementById('dm-invitations-list');
    if (!list || list.dataset.bound) return;
    list.dataset.bound = '1';

    // Delegated: rows are re-rendered whenever the queue changes.
    list.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const button = target.closest('[data-invite-action]');
        if (!button) return;
        const peer = button.getAttribute('data-invite-peer') || '';
        if (!peer) return;
        if (button.getAttribute('data-invite-action') === 'accept') onAccept(peer);
        else onDecline(peer);
    });
}

/**
 * @param {any[]} invitations
 */
export function renderInvitations(invitations) {
    const section = document.getElementById('dm-invitations');
    const list = document.getElementById('dm-invitations-list');
    const count = document.getElementById('dm-invitations-count');

    const entries = invitations || [];
    if (count) count.textContent = `${entries.length}`;

    // Also on the tab itself. An invitation arrives while the user is reading
    // the About page as often as not, and a toast that has already faded is no
    // longer a way to find it.
    const badge = document.getElementById('dm-tab-badge');
    if (badge) {
        badge.textContent = `${entries.length}`;
        badge.classList.toggle('hidden', entries.length === 0);
        const tab = document.querySelector('[data-tab="channels"]');
        if (tab) {
            if (entries.length > 0) {
                tab.setAttribute(
                    'aria-label',
                    `Direct Messenger, ${entries.length} chat invitation${entries.length === 1 ? '' : 's'} waiting`
                );
            } else {
                tab.removeAttribute('aria-label');
            }
        }
    }
    // The area is hidden entirely when empty rather than showing an empty
    // state: an invitation is an interruption, and no invitations is the
    // normal case.
    if (section) section.classList.toggle('hidden', entries.length === 0);
    if (!list) return;

    list.textContent = '';
    for (const invitation of entries) {
        list.appendChild(renderInvitationRow(invitation));
    }
}

/**
 * @param {any} invitation
 * @returns {HTMLElement}
 */
function renderInvitationRow(invitation) {
    const row = document.createElement('div');
    row.className = 'dm-invite';

    const body = document.createElement('div');
    body.className = 'dm-invite-body';

    const title = document.createElement('p');
    title.className = 'dm-invite-title';
    // The npub is the identity; a profile name is a relay-supplied convenience
    // and never stands alone, so an attacker cannot present as someone else by
    // choosing a display name.
    title.textContent = invitation.profileName
        ? `${invitation.profileName} · ${shortNpub(invitation.npub || invitation.peerNostrPublicKey)}`
        : shortNpub(invitation.npub || invitation.peerNostrPublicKey);
    body.appendChild(title);

    const npub = document.createElement('p');
    npub.className = 'dm-invite-npub';
    npub.textContent = invitation.npub || invitation.peerNostrPublicKey;
    body.appendChild(npub);

    const evm = document.createElement('p');
    evm.className = 'dm-invite-evm';
    // A request has no keys in it by design, so saying "no EVM identity" would
    // read as something missing rather than as the shape of a request. It must
    // not promise a check either: accepting sends consent, and the identity
    // tuple is verified later, on the offer that consent invites.
    evm.textContent =
        invitation.evmAddress ||
        (invitation.kind === 'request'
            ? 'Wants to start a chat · nothing is sent until you accept'
            : 'no EVM identity in the invitation');
    body.appendChild(evm);

    const meta = document.createElement('p');
    meta.className = 'dm-invite-meta';
    const received = invitation.receivedAt ? new Date(invitation.receivedAt).toLocaleTimeString() : '';
    const label = TRUST_LABELS[invitation.trustState] || TRUST_LABELS.unknown;
    const trust = document.createElement('span');
    trust.className = label.className;
    trust.textContent = label.text;
    meta.appendChild(trust);
    if (received) {
        const time = document.createElement('span');
        time.className = 'dm-invite-time';
        time.textContent = ` · ${received}`;
        meta.appendChild(time);
    }
    body.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'dm-invite-actions';

    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'btn btn-primary btn-sm';
    accept.textContent = 'Accept';
    accept.setAttribute('data-invite-action', 'accept');
    accept.setAttribute('data-invite-peer', invitation.peerNostrPublicKey);

    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'btn btn-secondary btn-sm';
    decline.textContent = 'Decline';
    decline.setAttribute('data-invite-action', 'decline');
    decline.setAttribute('data-invite-peer', invitation.peerNostrPublicKey);

    actions.appendChild(accept);
    actions.appendChild(decline);

    row.appendChild(body);
    row.appendChild(actions);
    return row;
}
