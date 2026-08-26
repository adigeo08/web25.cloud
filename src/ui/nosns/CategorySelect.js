// @ts-check
/**
 * DTAN category pickers.
 *
 * The taxonomy is local configuration mirrored from DTAN, so a picker is fully
 * populated whether or not `relay.dtan.xyz` is reachable — category loading and
 * relay connectivity are separate facts and are never reported as one.
 *
 * Options are built from `listDtanCategories()` alone, so the UI cannot emit a
 * category DTAN does not know: there is no free-text path into the value.
 */

import {
    listDtanCategories,
    dtanCategoryLabel,
    normalizeDtanCategory,
    DTAN_CATEGORIES
} from '../../nosns/NosNSProtocol.js';

/**
 * Fill a `<select>` with the DTAN tree, grouped by top-level category.
 *
 * @param {HTMLSelectElement|null} select
 * @param {string} [selected] a `tcat:` value to preselect
 */
export function populateCategorySelect(select, selected) {
    if (!select) return;

    select.textContent = '';
    const entries = listDtanCategories();

    for (const top of DTAN_CATEGORIES) {
        const group = document.createElement('optgroup');
        group.label = top.name;

        for (const entry of entries) {
            if (entry.path[0] !== top.tag) continue;
            const option = document.createElement('option');
            option.value = entry.tcat;
            // Indent by depth so the hierarchy reads inside a flat <select>.
            option.textContent = `${' '.repeat(entry.depth * 2)}${entry.label.split(' / ').pop()}`;
            option.title = `${entry.label} · ${entry.tcat}`;
            group.appendChild(option);
        }

        select.appendChild(group);
    }

    select.value = normalizeDtanCategory(selected || '');
}

/**
 * Read a picker's value, refusing anything outside the taxonomy.
 * @param {HTMLSelectElement|null} select
 * @returns {string} a valid `tcat:` value
 */
export function readCategorySelect(select) {
    return normalizeDtanCategory(select?.value || '');
}

/**
 * @param {HTMLSelectElement|null} select
 * @param {string} tcat
 */
export function setCategorySelect(select, tcat) {
    if (!select) return;
    select.value = normalizeDtanCategory(tcat);
}

/**
 * Lock the picker once the category has been committed to a signed event.
 * @param {HTMLSelectElement|null} select
 * @param {boolean} frozen
 */
export function freezeCategorySelect(select, frozen) {
    if (!select) return;
    select.disabled = Boolean(frozen);
    select.title = frozen ? 'Category is part of the signed NosNS event and cannot change for this deployment.' : '';
}

export { dtanCategoryLabel };
