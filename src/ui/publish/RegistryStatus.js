// @ts-check
/**
 * Registry status for the Deploy tab.
 *
 * Deployment and registry publication are separate outcomes and are always
 * shown as such: a site that is live and seeding stays live even if every
 * registry relay is unreachable.
 */

import { NOSTR_REGISTRY_CONFIG } from '../../config/nostr.config.js';

/** Human-readable form of the WEB25 category. */
export const WEB25_CATEGORY_LABEL = 'WEB25.cloud / Websites';

/**
 * @param {{ state: 'idle'|'signing'|'publishing'|'published'|'failed'|'skipped',
 *           accepted?: string[], attempted?: number, error?: string|null,
 *           npub?: string|null, eventId?: string|null }} status
 */
export function renderRegistryStatus(status) {
    const row = document.getElementById('result-registry-row');
    const stateEl = document.getElementById('result-registry-status');
    const categoryEl = document.getElementById('result-registry-category');
    const npubEl = document.getElementById('result-npub');
    const retryBtn = document.getElementById('retry-registry-btn');

    if (categoryEl) categoryEl.textContent = WEB25_CATEGORY_LABEL;
    if (npubEl) npubEl.textContent = status.npub || 'Unavailable';
    if (row) row.classList.remove('hidden');

    const accepted = status.accepted?.length ?? 0;
    const attempted = status.attempted ?? 0;

    let text;
    let className = 'status-chip status-pending';

    switch (status.state) {
        case 'signing':
            text = 'Signing registry event…';
            break;
        case 'publishing':
            text = 'Publishing to registry relays…';
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
 * @param {{ event?: any, publication?: any, relayStatus?: any[] }} details
 */
export function renderRegistryTechnicalDetails({ event = null, publication = null, relayStatus = [] }) {
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
                      category: NOSTR_REGISTRY_CONFIG.WEB25_CATEGORY,
                      tags: event.tags,
                      sig: event.sig
                  },
                  null,
                  2
              )
            : 'No registry event created for this deployment yet.';
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
                      note: 'Registry publication is discovery metadata only. Website content is distributed over BitTorrent and verified from .torrentchain after download.'
                  },
                  null,
                  2
              )
            : 'Registry publication has not run for this deployment yet.';
    }
}

/**
 * @param {(() => void)} onRetry
 */
export function bindRegistryRetry(onRetry) {
    const retryBtn = document.getElementById('retry-registry-btn');
    if (!retryBtn || retryBtn.dataset.bound) return;
    retryBtn.dataset.bound = '1';
    retryBtn.addEventListener('click', () => onRetry());
}
