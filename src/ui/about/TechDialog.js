// @ts-check
/**
 * The "Built on" band of the About page: each technology is a button that
 * opens one shared native dialog with a short explanation and a link to the
 * project, which opens in a new tab.
 *
 * The copy lives in index.html, one `<template id="lp-tech-<key>">` per
 * button (`data-tech="<key>"`), with the project's address in `data-url` and
 * the link's wording in `data-link-label`. Nothing here is parsed as markup:
 * the template's content is cloned, and the button's own name, role and icon
 * are copied as nodes and text.
 */

/**
 * @param {{ doc?: Document }} [options]
 * @returns {{ open: (key: string) => boolean } | null} null when the page has no band
 */
export function installTechDialogs({ doc = document } = {}) {
    const dialog = /** @type {HTMLDialogElement|null} */ (doc.getElementById('lp-tech-dialog'));
    const band = doc.querySelector('.lp-logos');
    if (!dialog || !band) return null;
    if (dialog.dataset.bound) return { open };
    dialog.dataset.bound = '1';

    const title = doc.getElementById('lp-tech-title');
    const role = doc.getElementById('lp-tech-role');
    const mark = doc.getElementById('lp-tech-mark');
    const body = doc.getElementById('lp-tech-body');
    const link = /** @type {HTMLAnchorElement|null} */ (doc.getElementById('lp-tech-link'));

    /**
     * Fill the dialog for one technology and show it.
     * @param {string} key
     */
    function open(key) {
        const button = band?.querySelector(`[data-tech="${CSS.escape(key)}"]`);
        const template = /** @type {HTMLTemplateElement|null} */ (doc.getElementById(`lp-tech-${key}`));
        if (!button || !template) return false;

        const name = button.querySelector('.lp-logo-name')?.textContent?.trim() || key;
        if (title) title.textContent = name;
        if (role) role.textContent = button.querySelector('.lp-logo-role')?.textContent?.trim() || '';
        const icon = button.querySelector('.lp-logo-mark');
        mark?.replaceChildren(...(icon ? [icon.cloneNode(true)] : []));
        body?.replaceChildren(template.content.cloneNode(true));
        if (link) {
            link.href = template.dataset.url || '#';
            link.textContent = `Visit ${template.dataset.linkLabel || name} ↗`;
        }

        if (typeof dialog.showModal === 'function') {
            if (!dialog.open) dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }
        return true;
    }

    band.addEventListener('click', (event) => {
        const button = /** @type {Element|null} */ (event.target)?.closest?.('[data-tech]');
        if (button) open(button.getAttribute('data-tech') || '');
    });
    // A click on the backdrop lands on the dialog itself, not on its card.
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });

    return { open };
}
