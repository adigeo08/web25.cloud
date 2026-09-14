/**
 * The gateway's slice of the DOM, on the shared fake document.
 *
 * Names the elements `LibraryPanel.js` reaches for by id: the one input, the
 * checkbox that decides what it is for, the two hint blocks it swaps between,
 * and the results page under them.
 */

import { installFakeDom } from './fake-dom.mjs';

/**
 * @returns {{ document: any, nodes: Record<string, any>, restore: () => void }}
 */
export function installFakeBrowseDom() {
    return installFakeDom({
        input: { tag: 'input', id: 'hash-input' },
        button: { tag: 'button', id: 'load-site' },
        toggle: { tag: 'input', id: 'gateway-search-mode' },
        loadHints: { tag: 'div', id: 'gateway-load-hints' },
        searchHints: { tag: 'div', id: 'gateway-search-hints', classes: ['hidden'] },
        section: { tag: 'section', id: 'site-library', classes: ['library', 'serp', 'hidden'] },
        count: { tag: 'p', id: 'library-count' },
        empty: { tag: 'p', id: 'library-empty', classes: ['hidden'] },
        results: { tag: 'div', id: 'library-results' }
    });
}
