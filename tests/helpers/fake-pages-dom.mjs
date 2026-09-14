/**
 * The Pages tab's own slice of the DOM, on the shared fake document.
 *
 * The element surface is in `fake-dom.mjs`; this only names the elements
 * `PagesPanel.js` reaches for by id, so the cards and the confirmation dialog
 * can be driven offline.
 */

import { installFakeDom } from './fake-dom.mjs';

/**
 * @returns {{ document: any, nodes: Record<string, any>, restore: () => void }}
 */
export function installFakePagesDom() {
    const dom = installFakeDom({
        tabBtn: { tag: 'button', attrs: { 'data-tab': 'pages' } },
        browseTab: { tag: 'button', attrs: { 'data-tab': 'browse' } },
        panel: { tag: 'section', id: 'tab-pages' },
        list: { tag: 'div', id: 'pages-list' },
        count: { tag: 'span', id: 'pages-count' },
        modal: { tag: 'div', id: 'stop-seeding-modal', classes: ['modal', 'hidden'] },
        title: { tag: 'h3', id: 'stop-seeding-title' },
        prompt: { tag: 'span', id: 'stop-seeding-prompt' },
        name: { tag: 'strong', id: 'stop-seeding-name' },
        detail: { tag: 'p', id: 'stop-seeding-detail' },
        confirm: { tag: 'button', id: 'stop-seeding-confirm' },
        cancel: { tag: 'button', id: 'stop-seeding-cancel' },
        close: { tag: 'button', id: 'stop-seeding-close' }
    });
    return dom;
}
