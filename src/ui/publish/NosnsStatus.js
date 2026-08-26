// @ts-check
/**
 * NosNS publication status for the Deploy tab.
 *
 * Deployment and NosNS publication are separate outcomes and are always shown
 * as such: a site that is live and seeding stays live even when the NosNS
 * directory relay is unreachable.
 */

import { dtanCategoryLabel } from '../../nosns/NosNSProtocol.js';
import {
    populateCategorySelect,
    readCategorySelect,
    setCategorySelect,
    freezeCategorySelect
} from '../nosns/CategorySelect.js';

/**
 * Reachability of `relay.dtan.xyz` itself.
 *
 * Deliberately independent of the category picker: categories are local
 * configuration, so "categories loaded" says nothing about the relay and this
 * chip never implies otherwise.
 *
 * @param {{ relay: string, reachable: boolean|null, error?: string|null }} status
 */
export function renderNosnsRelayStatus({ relay, reachable, error = null }) {
    const el = document.getElementById('nosns-relay-status');
    if (!el) return;

    const host = `${relay || ''}`.replace(/^wss?:\/\//, '');

    if (reachable === null) {
        el.textContent = `NosNS Directory ${host} · Checking…`;
        el.className = 'status-chip status-pending';
        return;
    }

    el.textContent = reachable
        ? `NosNS Directory ${host} · Connected`
        : `NosNS Directory ${host} · Unreachable${error ? ` · ${error}` : ''}`;
    el.className = reachable ? 'status-chip status-success' : 'status-chip status-error';
    el.title = reachable
        ? ''
        : 'Discovery only. Your site still deploys, seeds and loads by hash while the directory is down.';
}

/**
 * Wire the deploy-side DTAN category picker.
 * @param {(category: string) => void} onChange
 * @param {string} [initial]
 */
export function bindCategoryPicker(onChange, initial) {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('nosns-category-select'));
    if (!select) return;
    if (!select.dataset.populated) {
        populateCategorySelect(select, initial);
        select.dataset.populated = '1';
    } else if (initial) {
        setCategorySelect(select, initial);
    }
    if (select.dataset.bound) return;
    select.dataset.bound = '1';
    select.addEventListener('change', () => onChange(readCategorySelect(select)));
}

/** @param {string} category */
export function showSelectedCategory(category) {
    setCategorySelect(
        /** @type {HTMLSelectElement|null} */ (document.getElementById('nosns-category-select')),
        category
    );
}

/** @param {boolean} frozen */
export function setCategoryFrozen(frozen) {
    freezeCategorySelect(
        /** @type {HTMLSelectElement|null} */ (document.getElementById('nosns-category-select')),
        frozen
    );
}

/**
 * @param {{ state: 'idle'|'signing'|'publishing'|'published'|'failed'|'skipped',
 *           accepted?: string[], attempted?: number, error?: string|null,
 *           npub?: string|null, eventId?: string|null, category?: string|null,
 *           title?: string|null }} status
 */
export function renderNosnsStatus(status) {
    const row = document.getElementById('result-registry-row');
    const stateEl = document.getElementById('result-registry-status');
    const categoryEl = document.getElementById('result-registry-category');
    const titleEl = document.getElementById('result-nosns-name');
    const npubEl = document.getElementById('result-npub');
    const retryBtn = document.getElementById('retry-registry-btn');

    if (categoryEl) categoryEl.textContent = status.category ? dtanCategoryLabel(status.category) : 'Not selected';
    if (titleEl) titleEl.textContent = status.title || 'Pending';
    if (npubEl) npubEl.textContent = status.npub || 'Unavailable';
    if (row) row.classList.remove('hidden');

    const accepted = status.accepted?.length ?? 0;
    const attempted = status.attempted ?? 0;

    let text;
    let className = 'status-chip status-pending';

    switch (status.state) {
        case 'signing':
            text = 'Signing NosNS event…';
            break;
        case 'publishing':
            text = 'Publishing to relay.dtan.xyz…';
            break;
        case 'published':
            text = `Published to ${accepted} / ${attempted} relays`;
            className = 'status-chip status-success';
            break;
        case 'failed':
            text = `Not published${status.error ? ` · ${status.error}` : ''}`;
            className = 'status-chip status-error';
            break;
        case 'skipped':
            text = status.error || 'Not published';
            break;
        default:
            text = 'Pending';
    }

    if (stateEl) {
        stateEl.textContent = text;
        stateEl.className = className;
    }

    // Retry is offered only when there is a signed event to resubmit.
    if (retryBtn) {
        const canRetry = status.state === 'failed' && Boolean(status.eventId);
        retryBtn.classList.toggle('hidden', !canRetry);
    }
}

/**
 * Fill the technical-details panes: the exact signed NIP-35 event, and the
 * per-relay publication outcome.
 *
 * @param {{ event?: any, publication?: any, relayStatus?: any[], category?: string|null }} details
 */
export function renderNosnsTechnicalDetails({ event = null, publication = null, relayStatus = [], category = null }) {
    const eventEl = document.getElementById('registry-event-preview');
    const outputEl = document.getElementById('registry-publish-output');

    if (eventEl) {
        eventEl.textContent = event
            ? JSON.stringify(
                  {
                      id: event.id,
                      pubkey: event.pubkey,
                      kind: event.kind,
                      created_at: event.created_at,
                      category,
                      tags: event.tags,
                      sig: event.sig
                  },
                  null,
                  2
              )
            : 'No NosNS event created for this deployment yet.';
    }

    if (outputEl) {
        outputEl.textContent = publication
            ? JSON.stringify(
                  {
                      eventId: publication.eventId,
                      published: publication.ok,
                      acceptedBy: publication.accepted,
                      rejectedBy: publication.rejected,
                      relaysAttempted: publication.attempted,
                      error: publication.error,
                      relayStatus,
                      note: 'NosNS publication is discovery metadata only. Website content is distributed over BitTorrent and verified from .torrentchain after download.'
                  },
                  null,
                  2
              )
            : 'NosNS publication has not run for this deployment yet.';
    }
}

/**
 * @param {(() => void)} onRetry
 */
export function bindNosnsRetry(onRetry) {
    const retryBtn = document.getElementById('retry-registry-btn');
    if (!retryBtn || retryBtn.dataset.bound) return;
    retryBtn.dataset.bound = '1';
    retryBtn.addEventListener('click', () => onRetry());
}
