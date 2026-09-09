// @ts-check
/**
 * DOM layer for the Preview & Protect step.
 *
 * The step takes over the Deploy tab between staging files and building the
 * bundle: the normal deploy controls are hidden, the staged site is rendered in
 * the same opaque-origin sandbox a published site gets, and the publisher picks
 * the fragments to encrypt and the recipients who may open them.
 *
 * This module only renders and reads the DOM. Every decision — whether a
 * selection resolves, whether a key is usable, what gets encrypted — is made in
 * `Lifecycle.js` against the staged source, never here.
 */

const IDS = {
    workspace: 'protect-workspace',
    deployPanel: 'deploy-panel-main',
    fileSelect: 'protect-file-select',
    selectionHint: 'protect-selection-hint',
    addFragment: 'protect-add-btn',
    fragmentList: 'protect-fragment-list',
    fragmentEmpty: 'protect-fragment-empty',
    recipientInput: 'protect-recipient-input',
    recipientAdd: 'protect-recipient-add',
    recipientList: 'protect-recipient-list',
    recipientError: 'protect-recipient-error',
    ownerRow: 'protect-owner-row',
    back: 'protect-back-btn',
    next: 'protect-next-btn',
    status: 'protect-status'
};

/** @param {string} id */
function el(id) {
    return document.getElementById(id);
}

/**
 * Show or hide the protection workspace, hiding the normal deploy UI while it
 * is up so the publisher is never looking at two workflows at once.
 * @param {boolean} active
 */
export function setProtectWorkspaceVisible(active) {
    const workspace = el(IDS.workspace);
    const deployMain = el(IDS.deployPanel);
    if (workspace) workspace.classList.toggle('hidden', !active);
    if (deployMain) deployMain.classList.toggle('hidden', active);
}

/**
 * @param {{ onBack: () => void, onNext: () => void, onAddRecipient: () => void,
 *           onFileChange: (path: string) => void, onProtectSelection: () => void }} handlers
 */
export function bindProtectWorkspace({ onBack, onNext, onAddRecipient, onFileChange, onProtectSelection }) {
    el(IDS.back)?.addEventListener('click', onBack);
    el(IDS.next)?.addEventListener('click', onNext);
    el(IDS.addFragment)?.addEventListener('click', onProtectSelection);
    el(IDS.recipientAdd)?.addEventListener('click', onAddRecipient);
    el(IDS.recipientInput)?.addEventListener('keydown', (event) => {
        if (/** @type {KeyboardEvent} */ (event).key === 'Enter') {
            event.preventDefault();
            onAddRecipient();
        }
    });
    el(IDS.fileSelect)?.addEventListener('change', (event) => {
        onFileChange(/** @type {HTMLSelectElement} */ (event.target).value);
    });
}

/**
 * @param {string[]} paths
 * @param {string} activePath
 */
export function renderProtectFileList(paths, activePath) {
    const select = /** @type {HTMLSelectElement | null} */ (el(IDS.fileSelect));
    if (!select) return;
    select.textContent = '';
    for (const path of paths) {
        const option = document.createElement('option');
        option.value = path;
        option.textContent = path;
        if (path === activePath) option.selected = true;
        select.appendChild(option);
    }
    select.disabled = paths.length <= 1;
}

/**
 * @param {string} message
 * @param {boolean} [canProtect] whether the current selection resolved cleanly
 */
export function renderProtectSelectionHint(message, canProtect = false) {
    const hint = el(IDS.selectionHint);
    if (hint) hint.textContent = message;
    const button = /** @type {HTMLButtonElement | null} */ (el(IDS.addFragment));
    if (button) button.disabled = !canProtect;
}

/** @param {string} message */
export function renderProtectStatus(message) {
    const status = el(IDS.status);
    if (status) status.textContent = message;
}

/**
 * @param {{ assetId: string, path: string, preview: string, recipientCount: number }[]} fragments
 * @param {(assetId: string) => void} onRemove
 */
export function renderProtectedFragments(fragments, onRemove) {
    const list = el(IDS.fragmentList);
    const empty = el(IDS.fragmentEmpty);
    if (!list) return;

    list.textContent = '';
    if (empty) empty.classList.toggle('hidden', fragments.length > 0);

    for (const fragment of fragments) {
        const row = document.createElement('li');
        row.className = 'protect-fragment';

        const label = document.createElement('span');
        label.className = 'protect-fragment-text';
        label.textContent = `“${fragment.preview}”`;

        const meta = document.createElement('span');
        meta.className = 'protect-fragment-meta';
        meta.textContent = `${fragment.path} · ${fragment.recipientCount} recipient${
            fragment.recipientCount === 1 ? '' : 's'
        }`;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-secondary';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => onRemove(fragment.assetId));

        row.append(label, meta, remove);
        list.appendChild(row);
    }
}

/**
 * @param {{ publicKey: string, address: string }} owner
 * @param {{ publicKey: string, address: string }[]} recipients
 * @param {(publicKey: string) => void} onRemove
 */
export function renderProtectRecipients(owner, recipients, onRemove) {
    const ownerRow = el(IDS.ownerRow);
    if (ownerRow) {
        // The owner is implicit and has no Remove control: a publisher who
        // could drop their own grant would lose their own content.
        ownerRow.textContent = `You (owner) · ${owner.address} · always authorised`;
    }

    const list = el(IDS.recipientList);
    if (!list) return;
    list.textContent = '';

    for (const recipient of recipients) {
        const row = document.createElement('li');
        row.className = 'protect-recipient';

        const address = document.createElement('code');
        address.textContent = recipient.address;

        const key = document.createElement('span');
        key.className = 'protect-recipient-key';
        key.textContent = `${recipient.publicKey.slice(0, 12)}…${recipient.publicKey.slice(-6)}`;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-secondary';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => onRemove(recipient.publicKey));

        row.append(address, key, remove);
        list.appendChild(row);
    }
}

/** @returns {string} */
export function readRecipientInput() {
    const input = /** @type {HTMLInputElement | null} */ (el(IDS.recipientInput));
    return input ? `${input.value || ''}`.trim() : '';
}

export function clearRecipientInput() {
    const input = /** @type {HTMLInputElement | null} */ (el(IDS.recipientInput));
    if (input) input.value = '';
}

/** @param {string} message */
export function renderRecipientError(message) {
    const error = el(IDS.recipientError);
    if (error) {
        error.textContent = message;
        error.classList.toggle('hidden', !message);
    }
}

/** @param {boolean} busy */
export function setProtectBusy(busy) {
    const next = /** @type {HTMLButtonElement | null} */ (el(IDS.next));
    const back = /** @type {HTMLButtonElement | null} */ (el(IDS.back));
    if (next) next.disabled = busy;
    if (back) back.disabled = busy;
}

export const PROTECT_PANEL_IDS = IDS;
