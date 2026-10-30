// @ts-check
/**
 * The chat's micro IDE: the Project panel and the canvas.
 *
 *   Project panel   the open conversation's files as a tree. Files and folders
 *                   are created, renamed, deleted and moved — dragged onto a
 *                   folder, sent up a level with the arrow, or sent anywhere
 *                   with Move to — in a draft; Save commits the whole draft at
 *                   once, Discard drops it. Deploy project is at its foot.
 *   Canvas          one file, previewed and edited. Preview puts the project's
 *                   page together and runs it in a sandboxed frame, with its
 *                   console underneath; Code is CodeMirror 6. Save writes the
 *                   file to the project and to the model's memory.
 *
 * File names and code come from the model or the user and are untrusted: they
 * are only ever set as text, and code only ever runs in the preview frame,
 * which is sandboxed without `allow-same-origin`.
 */

import { ProjectDraft, buildTree, joinPath, parentOf, validName } from '../../webllm/projectTree.js';
import { CANVAS_MESSAGE_SOURCE, buildPreviewDocument } from '../../webllm/canvasPreview.js';
import { createCodeEditor, editorLanguage } from '../../webllm/codeEditor.js';
import { extractCodeFiles, projectPath } from '../../webllm/chatProject.js';

/** @param {string} id */
const byId = (id) => document.getElementById(id);

/** @param {Element|null} el @param {boolean} hidden */
const setHidden = (el, hidden) => el?.classList.toggle('hidden', hidden);

/** @param {string} path */
const extensionOf = (path) => (path.includes('.') ? path.split('.').pop()?.toLowerCase() || '' : '');

const ICONS = {
    up: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v5',
    rename: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    remove: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3'
};

/** @param {keyof typeof ICONS} name */
function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.9');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/**
 * @param {{ project: import('../../webllm/chatProject.js').WebLLMProject,
 *           controller: any,
 *           sidebar: import('./WebLLMPanel.js').SidebarControl,
 *           confirm?: (message: string) => boolean,
 *           loadEditor?: () => Promise<any> }} deps
 */
export function bindWebLLMWorkbench({
    project,
    controller,
    sidebar,
    confirm = (message) => window.confirm(message),
    loadEditor
}) {
    /** How the chat names the model this page runs. */
    const modelName = controller?.model?.name || 'Llama';
    const layout = byId('webllm-layout');

    // ── the Project panel ───────────────────────────────────────────────────

    const tree = byId('webllm-tree');
    const scroll = tree?.parentElement || null;
    /** @type {ProjectDraft} */
    let draft = new ProjectDraft();
    let draftKey = '';
    /** The folder new files and folders go into; '' is the top. */
    let target = '';
    /** @type {string|null} */
    let selected = null;
    /** @type {Set<string>} */
    const collapsed = new Set();
    /** @type {string|null} the row being renamed */
    let renaming = null;
    /** @type {'file'|'dir'|null} */
    let creating = null;

    /** @param {string} message */
    function showError(message) {
        const error = byId('webllm-tree-error');
        if (error) error.textContent = message;
        setHidden(error, !message);
    }

    /** @param {() => any} change */
    function change(change) {
        try {
            change();
            showError('');
        } catch (error) {
            showError(`${/** @type {any} */ (error)?.message || error}`);
        }
        renderTree();
    }

    /** @param {import('../../webllm/projectTree.js').TreeNode} node @param {number} depth */
    function row(node, depth) {
        const item = el('li', 'webllm-tree-item');
        item.setAttribute('role', 'treeitem');
        item.setAttribute('aria-level', `${depth + 1}`);
        item.dataset.path = node.path;
        item.dataset.kind = node.kind;
        const isOpen = node.kind === 'dir' && !collapsed.has(node.path);
        if (node.kind === 'dir') item.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        item.setAttribute('aria-selected', selected === node.path ? 'true' : 'false');

        const line = el('div', 'webllm-tree-row');
        line.draggable = renaming !== node.path;
        line.dataset.row = node.path;
        line.style.setProperty('--depth', `${depth}`);
        if (selected === node.path) line.classList.add('is-selected');
        if (canvas.path === node.path && canvas.open) line.classList.add('is-open');

        const caret = el('span', 'webllm-tree-caret');
        caret.setAttribute('aria-hidden', 'true');
        if (node.kind === 'dir') caret.textContent = isOpen ? '▾' : '▸';
        const badge = el('span', 'webllm-file-badge');
        badge.setAttribute('aria-hidden', 'true');
        if (node.kind === 'dir') badge.dataset.kind = 'dir';
        else badge.dataset.ext = extensionOf(node.name);
        line.append(caret, badge);

        if (renaming === node.path) {
            const form = el('form', 'webllm-tree-rename');
            const input = /** @type {HTMLInputElement} */ (el('input', 'webllm-tree-input'));
            input.value = node.name;
            input.maxLength = 80;
            input.spellcheck = false;
            input.setAttribute('aria-label', `New name for ${node.name}`);
            form.appendChild(input);
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                const from = node.path;
                renaming = null;
                change(() => {
                    const to = draft.rename(from, input.value);
                    if (selected === from) selected = to;
                    if (canvas.path === from) setCanvasPath(to);
                });
            });
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    renaming = null;
                    renderTree();
                }
            });
            input.addEventListener('blur', () => form.requestSubmit?.());
            line.appendChild(form);
            queueMicrotask(() => {
                input.focus();
                input.setSelectionRange(
                    0,
                    node.name.lastIndexOf('.') > 0 ? node.name.lastIndexOf('.') : node.name.length
                );
            });
        } else {
            line.appendChild(el('span', 'webllm-tree-name', node.name));
        }

        const status = draft.statusOf(node.path);
        if (status) {
            const mark = el('span', 'webllm-tree-mark', status === 'added' ? 'A' : 'M');
            mark.dataset.status = status;
            mark.title = status === 'added' ? 'New — not saved yet' : 'Moved or renamed — not saved yet';
            line.appendChild(mark);
        }

        const actions = el('span', 'webllm-tree-actions');
        if (node.path.includes('/')) {
            const up = el('button', 'webllm-row-btn');
            up.setAttribute('type', 'button');
            up.dataset.treeAction = 'up';
            up.title = 'Move up a level';
            up.setAttribute('aria-label', `Move ${node.name} up a level`);
            up.appendChild(icon('up'));
            actions.appendChild(up);
        }
        const move = /** @type {HTMLSelectElement} */ (el('select', 'webllm-tree-move'));
        move.dataset.treeMove = node.path;
        move.setAttribute('aria-label', `Move ${node.name} to a folder`);
        move.title = 'Move to a folder';
        move.appendChild(new Option('Move to…', ''));
        const here = parentOf(node.path);
        for (const dir of ['', ...draft.dirs()]) {
            if (dir === here || (node.kind === 'dir' && (dir === node.path || dir.startsWith(`${node.path}/`)))) {
                continue;
            }
            move.appendChild(new Option(dir ? `${dir}/` : '/ (top)', dir || '/'));
        }
        if (move.options.length > 1) actions.appendChild(move);
        const rename = el('button', 'webllm-row-btn');
        rename.setAttribute('type', 'button');
        rename.dataset.treeAction = 'rename';
        rename.title = 'Rename';
        rename.setAttribute('aria-label', `Rename ${node.name}`);
        rename.appendChild(icon('rename'));
        const remove = el('button', 'webllm-row-btn is-danger');
        remove.setAttribute('type', 'button');
        remove.dataset.treeAction = 'delete';
        remove.title = 'Delete';
        remove.setAttribute('aria-label', `Delete ${node.name}`);
        remove.appendChild(icon('remove'));
        actions.append(rename, remove);
        line.appendChild(actions);
        item.appendChild(line);

        if (node.kind === 'dir' && isOpen && node.children.length > 0) {
            const group = el('ul', 'webllm-tree-group');
            group.setAttribute('role', 'group');
            for (const child of node.children) group.appendChild(row(child, depth + 1));
            item.appendChild(group);
        }
        return item;
    }

    function renderTree() {
        if (!tree) return;
        const state = project.state;
        const root = buildTree(draft.files(), draft.dirs());
        tree.textContent = '';
        for (const child of root.children) tree.appendChild(row(child, 0));

        const empty = byId('webllm-tree-empty');
        setHidden(empty, root.children.length > 0);
        const emptyText = empty?.lastElementChild;
        if (emptyText) {
            emptyText.textContent = state.conversationId
                ? `Ask ${modelName} for code, save a snippet, or create a file.`
                : `Send ${modelName} a message first: a project belongs to a conversation.`;
        }
        const ready = Boolean(state.conversationId && state.available);
        for (const id of ['webllm-tree-new-file', 'webllm-tree-new-folder']) {
            const button = /** @type {any} */ (byId(id));
            if (button) button.disabled = !ready;
        }
        const label = byId('webllm-tree-target');
        if (label) label.textContent = target ? `in ${target}/` : 'in /';

        const changes = draft.changes().length;
        setHidden(byId('webllm-tree-pending'), changes === 0);
        const pending = byId('webllm-tree-pending-label');
        if (pending) {
            pending.textContent = `${changes} ${changes === 1 ? 'change' : 'changes'}`;
            pending.title = `${changes} unsaved ${changes === 1 ? 'change' : 'changes'} — Save commits them together`;
        }
    }

    /** @param {import('../../webllm/chatProject.js').ProjectState} state */
    function syncDraft(state) {
        const key = JSON.stringify([state.conversationId, state.files, state.dirs]);
        if (key === draftKey) return;
        const sameProject = JSON.parse(draftKey || '[null]')[0] === state.conversationId;
        draftKey = key;
        // A draft with unsaved changes is kept while it is the same project:
        // a reply that adds a file does not throw away the user's reorganising.
        if (draft.dirty && sameProject) {
            for (const path of state.files) {
                if (!draft.originalFiles.has(path) && !draft.exists(path)) draft.adopt(path);
            }
            return;
        }
        draft = new ProjectDraft({ files: state.files, dirs: state.dirs || [] });
        if (!sameProject) {
            selected = null;
            target = '';
            collapsed.clear();
        }
    }

    tree?.addEventListener('click', (event) => {
        const any = /** @type {any} */ (event.target);
        if (any?.closest?.('select, form')) return;
        const item = any?.closest?.('.webllm-tree-item');
        if (!item) return;
        const path = item.dataset.path;
        const action = any?.closest?.('[data-tree-action]')?.dataset?.treeAction;
        if (action === 'up') return change(() => moveTo(path, parentOf(parentOf(path))));
        if (action === 'rename') {
            renaming = path;
            return renderTree();
        }
        if (action === 'delete') {
            const what = item.dataset.kind === 'dir' ? `the folder ${path} and everything in it` : path;
            if (!confirm(`Delete ${what}? It goes when you press Save.`)) return;
            return change(() => {
                draft.remove(path);
                if (selected === path) selected = null;
                if (target === path || target.startsWith(`${path}/`)) target = '';
            });
        }
        selected = path;
        if (item.dataset.kind === 'dir') {
            target = path;
            if (collapsed.has(path)) collapsed.delete(path);
            else collapsed.add(path);
            return renderTree();
        }
        target = parentOf(path);
        renderTree();
        void openFile(path);
    });

    tree?.addEventListener('change', (event) => {
        const select = /** @type {any} */ (event.target);
        if (!select?.dataset?.treeMove || !select.value) return;
        const destination = select.value === '/' ? '' : select.value;
        change(() => moveTo(select.dataset.treeMove, destination));
    });

    /** @param {string} path @param {string} destination */
    function moveTo(path, destination) {
        const moved = draft.move(path, destination);
        if (selected === path) selected = moved;
        if (canvas.path === path) setCanvasPath(moved);
        collapsed.delete(destination);
        return moved;
    }

    // Drag and drop: a row onto a folder, or onto the empty space for the top.
    /** @type {string|null} */
    let dragged = null;
    /** @param {any} target */
    const dropFolderOf = (target) => {
        const item = target?.closest?.('.webllm-tree-item');
        if (!item) return '';
        return item.dataset.kind === 'dir' ? item.dataset.path : parentOf(item.dataset.path);
    };
    const clearDrop = () =>
        tree?.querySelectorAll('.is-drop-target').forEach((node) => node.classList.remove('is-drop-target'));
    tree?.addEventListener('dragstart', (event) => {
        const line = /** @type {any} */ (event.target)?.closest?.('.webllm-tree-row');
        if (!line) return;
        dragged = line.dataset.row;
        event.dataTransfer?.setData('text/plain', dragged || '');
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        line.classList.add('is-dragging');
    });
    tree?.addEventListener('dragend', () => {
        dragged = null;
        clearDrop();
        tree.querySelectorAll('.is-dragging').forEach((node) => node.classList.remove('is-dragging'));
    });
    scroll?.addEventListener('dragover', (event) => {
        if (!dragged) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        clearDrop();
        const folder = dropFolderOf(event.target);
        const node = folder ? tree?.querySelector(`[data-row="${CSS.escape(folder)}"]`) : tree;
        node?.classList.add('is-drop-target');
    });
    scroll?.addEventListener('dragleave', (event) => {
        if (!scroll.contains(/** @type {any} */ (event).relatedTarget)) clearDrop();
    });
    scroll?.addEventListener('drop', (event) => {
        if (!dragged) return;
        event.preventDefault();
        const source = dragged;
        const folder = dropFolderOf(event.target);
        dragged = null;
        clearDrop();
        if (parentOf(source) === folder) return renderTree();
        change(() => moveTo(source, folder));
    });

    // New file / new folder, named in place.
    const newForm = /** @type {HTMLFormElement|null} */ (byId('webllm-tree-new'));
    const newName = /** @type {HTMLInputElement|null} */ (byId('webllm-tree-new-name'));
    /** @param {'file'|'dir'} kind */
    function startCreating(kind) {
        creating = kind;
        setHidden(newForm, false);
        const badge = byId('webllm-tree-new-icon');
        if (badge) badge.dataset.kind = kind;
        if (newName) {
            newName.value = '';
            newName.placeholder = kind === 'dir' ? 'folder name' : 'file.html';
            newName.focus();
        }
    }
    function stopCreating() {
        creating = null;
        setHidden(newForm, true);
    }
    byId('webllm-tree-new-file')?.addEventListener('click', () => startCreating('file'));
    byId('webllm-tree-new-folder')?.addEventListener('click', () => startCreating('dir'));
    byId('webllm-tree-new-cancel')?.addEventListener('click', stopCreating);
    newName?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') stopCreating();
    });
    newForm?.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = validName(newName?.value || '');
        if (!name) return showError('Use letters, digits, dots, dashes or spaces for a name.');
        const kind = creating;
        const path = joinPath(target, name);
        if (kind === 'dir' && !projectPath(`${path}/x.txt`)) return showError('That folder name cannot be used.');
        if (kind === 'file' && !projectPath(path)) {
            return showError('Use a file name like page.html, site.css or app.js.');
        }
        stopCreating();
        change(() => {
            if (kind === 'dir') {
                draft.mkdir(path);
                target = path;
                collapsed.delete(path);
            } else draft.createFile(path);
            selected = path;
        });
        if (kind === 'file') void openBuffer({ path, code: '', saved: null, view: 'code' });
    });

    byId('webllm-tree-discard')?.addEventListener('click', () => {
        draft = new ProjectDraft({ files: project.state.files, dirs: project.state.dirs || [] });
        showError('');
        renderTree();
    });
    byId('webllm-tree-save')?.addEventListener('click', async () => {
        const changes = draft.changes();
        if (changes.length === 0) return;
        const button = /** @type {any} */ (byId('webllm-tree-save'));
        if (button) button.disabled = true;
        try {
            await project.applyChanges(changes, draft.summary());
            draft = new ProjectDraft({ files: project.state.files, dirs: project.state.dirs || [] });
            draftKey = JSON.stringify([project.state.conversationId, project.state.files, project.state.dirs]);
            showError('');
            await refreshPreviewFiles();
        } catch (error) {
            showError(`Not saved: ${/** @type {any} */ (error)?.message || error}`);
        } finally {
            if (button) button.disabled = false;
            renderTree();
        }
    });

    const deploy = /** @type {any} */ (byId('webllm-deploy-project-btn'));
    deploy?.addEventListener('click', () => {
        void project.deploy().catch(() => {});
    });

    // ── the canvas ──────────────────────────────────────────────────────────

    const canvasEl = byId('webllm-canvas');
    const frame = /** @type {HTMLIFrameElement|null} */ (byId('webllm-canvas-frame'));
    const pathInput = /** @type {HTMLInputElement|null} */ (byId('webllm-canvas-path'));
    const canvasBtn = byId('webllm-canvas-btn');
    const canvas = {
        open: false,
        /** @type {'preview'|'code'} */
        view: 'preview',
        path: '',
        code: '',
        /** the text the project holds for `path`, or null when it holds none */
        /** @type {string|null} */
        saved: null,
        /** the path the buffer was loaded from */
        savedPath: '',
        saving: false,
        error: '',
        /** @type {Map<string, string>} */
        files: new Map(),
        /** @type {import('../../webllm/codeEditor.js').CodeEditor|null} */
        editor: null,
        /** @type {Promise<any>|null} */
        editorLoading: null
    };
    /** @type {any} */
    let previewTimer = null;

    const isDirty = () => canvas.saved === null || canvas.code !== canvas.saved || canvas.path !== canvas.savedPath;

    function renderCanvas() {
        layout?.classList.toggle('is-canvas-open', canvas.open);
        setHidden(canvasEl, !canvas.open);
        canvasBtn?.setAttribute('aria-expanded', canvas.open ? 'true' : 'false');
        canvasBtn?.classList.toggle('is-active', canvas.open);
        const hasFile = Boolean(canvas.path);
        setHidden(byId('webllm-canvas-empty'), hasFile);
        setHidden(byId('webllm-canvas-preview'), !hasFile || canvas.view !== 'preview');
        setHidden(byId('webllm-canvas-code'), !hasFile || canvas.view !== 'code');
        for (const tab of document.querySelectorAll('[data-canvas-view]')) {
            const selectedTab = /** @type {any} */ (tab).dataset.canvasView === canvas.view;
            tab.setAttribute('aria-selected', selectedTab ? 'true' : 'false');
            tab.setAttribute('tabindex', selectedTab ? '0' : '-1');
        }
        if (pathInput && pathInput.value !== canvas.path && document.activeElement !== pathInput) {
            pathInput.value = canvas.path;
        }
        const badge = byId('webllm-canvas-badge');
        if (badge) badge.dataset.ext = extensionOf(canvas.path);

        const status = byId('webllm-canvas-status');
        if (status) {
            const state = canvas.saving
                ? 'saving'
                : canvas.error
                  ? 'error'
                  : !hasFile
                    ? 'idle'
                    : canvas.saved === null
                      ? 'new'
                      : isDirty()
                        ? 'dirty'
                        : 'saved';
            status.dataset.state = state;
            status.textContent = {
                saving: 'Saving…',
                error: 'Not saved',
                idle: '',
                new: 'Not in project',
                dirty: 'Unsaved changes',
                saved: 'Saved'
            }[state];
            status.title = canvas.error || status.textContent || '';
        }
        const save = /** @type {any} */ (byId('webllm-canvas-save'));
        if (save) save.disabled = !hasFile || canvas.saving || !project.state.conversationId || !isDirty();
        const reload = /** @type {any} */ (byId('webllm-canvas-reload'));
        if (reload) reload.disabled = !hasFile;
    }

    /** @param {string} path */
    function setCanvasPath(path) {
        canvas.path = path;
        canvas.savedPath = path;
        renderCanvas();
    }

    async function refreshPreviewFiles() {
        if (!project.state.conversationId || !project.state.available) {
            canvas.files = new Map();
            return;
        }
        try {
            canvas.files = await project.readAll();
        } catch (_) {
            canvas.files = new Map();
        }
    }

    function renderPreview() {
        clearTimeout(previewTimer);
        if (!frame || !canvas.path) return;
        clearConsole();
        frame.srcdoc = buildPreviewDocument({ path: canvas.path, code: canvas.code, files: canvas.files }).html;
    }

    function schedulePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(renderPreview, 450);
    }

    async function ensureEditor() {
        const host = byId('webllm-canvas-editor');
        if (!host) return null;
        if (canvas.editor) return canvas.editor;
        if (!canvas.editorLoading) {
            const note = byId('webllm-canvas-editor-note');
            if (note) note.textContent = 'Loading the editor…';
            setHidden(note, false);
            canvas.editorLoading = createCodeEditor(host, {
                doc: canvas.code,
                path: canvas.path,
                load: loadEditor,
                onChange: (value) => {
                    canvas.code = value;
                    canvas.error = '';
                    renderCanvas();
                },
                onSave: () => void saveCanvas()
            }).then((editor) => {
                canvas.editor = editor;
                if (note) {
                    note.textContent =
                        editor.kind === 'textarea'
                            ? 'CodeMirror could not be loaded from the CDN, so this is a plain editor. Saving works the same.'
                            : '';
                }
                setHidden(note, editor.kind !== 'textarea');
                return editor;
            });
        }
        return canvas.editorLoading;
    }

    /** @param {'preview'|'code'} view */
    async function showView(view) {
        canvas.view = view;
        renderCanvas();
        if (view === 'preview') renderPreview();
        else {
            const editor = await ensureEditor();
            if (editor && editor.getValue() !== canvas.code) editor.setValue(canvas.code, canvas.path);
            editor?.focus();
        }
    }

    /**
     * Put a buffer in the canvas, asking first when that would drop unsaved
     * changes.
     * @param {{ path: string, code: string, saved: string|null, view: 'preview'|'code' }} buffer
     */
    async function openBuffer({ path, code, saved, view }) {
        if (
            canvas.path &&
            canvas.open &&
            isDirty() &&
            canvas.code.trim() &&
            (canvas.path !== path || canvas.code !== code)
        ) {
            if (!confirm(`Discard the unsaved changes to ${canvas.path}?`)) return false;
        }
        Object.assign(canvas, { open: true, path, code, saved, savedPath: saved === null ? '' : path, error: '' });
        sidebar.closeOnPhone();
        await refreshPreviewFiles();
        if (canvas.editor) canvas.editor.setValue(code, path);
        await showView(view);
        renderTree();
        return true;
    }

    /** @param {string} path */
    async function openFile(path) {
        if (draft.statusOf(path) === 'added' && !project.state.files.includes(path)) {
            return openBuffer({ path, code: '', saved: null, view: 'code' });
        }
        let code;
        try {
            code = await project.readFile(path);
        } catch (error) {
            return showError(`Could not open ${path}: ${/** @type {any} */ (error)?.message || error}`);
        }
        const kind = editorLanguage(path);
        return openBuffer({ path, code, saved: code, view: kind === 'html' ? 'preview' : 'code' });
    }

    /** @param {{ messageId: string, index: number, name: string }} snippet */
    async function openSnippet({ messageId, index, name }) {
        const message = (controller.state.messages || []).find(
            (/** @type {any} */ entry) => `${entry.id}` === `${messageId}`
        );
        const block = message
            ? extractCodeFiles(message.content, { finished: !message.pending }).find((file) => file.index === index)
            : null;
        if (!block) return false;
        const path = projectPath(name) || block.suggested || 'snippet.txt';
        let saved = null;
        if (project.state.files.includes(path)) {
            try {
                saved = await project.readFile(path);
            } catch (_) {
                saved = null;
            }
        }
        return openBuffer({ path, code: block.code, saved, view: 'preview' });
    }

    async function saveCanvas() {
        if (!canvas.path || canvas.saving) return;
        const path = projectPath(pathInput?.value || canvas.path);
        if (!path) {
            canvas.error = 'Use a file name like index.html, style.css or js/app.js.';
            return renderCanvas();
        }
        canvas.saving = true;
        canvas.error = '';
        renderCanvas();
        try {
            const savedPath = await project.writeFile(path, canvas.code);
            if (draft.statusOf(savedPath) === 'added') draft.adopt(savedPath);
            Object.assign(canvas, { path: savedPath, savedPath, saved: canvas.code });
            await refreshPreviewFiles();
            if (canvas.view === 'preview') renderPreview();
        } catch (error) {
            canvas.error = `${/** @type {any} */ (error)?.message || error}`;
        } finally {
            canvas.saving = false;
            renderCanvas();
            renderTree();
        }
    }

    function closeCanvas() {
        if (
            canvas.path &&
            isDirty() &&
            canvas.code.trim() &&
            !confirm(`Close the canvas? Unsaved changes to ${canvas.path} are lost.`)
        ) {
            return;
        }
        clearTimeout(previewTimer);
        Object.assign(canvas, { open: false, path: '', code: '', saved: null, savedPath: '', error: '' });
        if (frame) frame.srcdoc = '';
        renderCanvas();
        renderTree();
    }

    canvasBtn?.addEventListener('click', () => {
        if (canvas.open) return closeCanvas();
        const start = project.state.files.includes('index.html') ? 'index.html' : project.state.files[0];
        if (start) void openFile(start);
        else {
            canvas.open = true;
            sidebar.closeOnPhone();
            renderCanvas();
        }
    });
    byId('webllm-canvas-close')?.addEventListener('click', closeCanvas);
    byId('webllm-canvas-save')?.addEventListener('click', () => void saveCanvas());
    byId('webllm-canvas-reload')?.addEventListener('click', async () => {
        await refreshPreviewFiles();
        if (canvas.view !== 'preview') await showView('preview');
        else renderPreview();
    });
    for (const tab of document.querySelectorAll('[data-canvas-view]')) {
        tab.addEventListener('click', () => void showView(/** @type {any} */ (tab).dataset.canvasView));
        tab.addEventListener('keydown', (event) => {
            const key = /** @type {any} */ (event).key;
            if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
            const next = canvas.view === 'preview' ? 'code' : 'preview';
            void showView(next).then(() => /** @type {any} */ (byId(`webllm-canvas-tab-${next}`))?.focus());
        });
    }
    pathInput?.addEventListener('input', () => {
        canvas.path = pathInput.value.trim();
        canvas.error = '';
        const badge = byId('webllm-canvas-badge');
        if (badge) badge.dataset.ext = extensionOf(canvas.path);
        renderCanvas();
    });
    pathInput?.addEventListener('change', () => {
        if (canvas.editor) canvas.editor.setValue(canvas.code, canvas.path);
        if (canvas.view === 'preview') schedulePreview();
    });
    canvasEl?.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            void saveCanvas();
        }
    });

    // The preview's console, posted from inside the sandboxed frame.
    const consoleLog = byId('webllm-canvas-console-log');
    const consoleCount = byId('webllm-canvas-console-count');
    let consoleEntries = 0;
    function clearConsole() {
        consoleEntries = 0;
        if (consoleLog) consoleLog.textContent = '';
        if (consoleCount) {
            consoleCount.textContent = '0';
            consoleCount.dataset.level = '';
        }
    }
    globalThis.addEventListener?.('message', (event) => {
        if (!frame || event.source !== frame.contentWindow) return;
        const data = /** @type {any} */ (event).data;
        if (data?.source !== CANVAS_MESSAGE_SOURCE || consoleEntries >= 200) return;
        consoleEntries += 1;
        const level = ['log', 'info', 'warn', 'error', 'debug'].includes(data.level) ? data.level : 'log';
        const entry = el('li', 'webllm-console-entry', `${data.text || ''}`.slice(0, 2000));
        entry.dataset.level = level;
        consoleLog?.appendChild(entry);
        if (consoleCount) {
            consoleCount.textContent = `${consoleEntries}`;
            if (level === 'error' || (level === 'warn' && consoleCount.dataset.level !== 'error')) {
                consoleCount.dataset.level = level;
            }
        }
        if (level === 'error') /** @type {any} */ (byId('webllm-canvas-console')).open = true;
    });

    // ── following the project ───────────────────────────────────────────────

    let shownConversation = /** @type {string|null} */ (null);

    /** @param {import('../../webllm/chatProject.js').ProjectState} state */
    function renderProject(state) {
        const usable = state.available;
        setHidden(byId('webllm-project-toggle'), !usable);
        setHidden(canvasBtn, !usable);
        if (!usable && sidebar.state.panel === 'project') sidebar.open('conversations');

        // Another conversation: its own project, and nothing of the last one's.
        if (state.conversationId !== shownConversation) {
            shownConversation = state.conversationId;
            if (canvas.open) {
                clearTimeout(previewTimer);
                Object.assign(canvas, { open: false, path: '', code: '', saved: null, savedPath: '', error: '' });
                if (frame) frame.srcdoc = '';
            }
        }

        syncDraft(state);
        const count = byId('webllm-project-count');
        if (count) count.textContent = `${state.files.length}`;
        const badge = byId('webllm-project-badge');
        if (badge) badge.textContent = state.files.length ? `${state.files.length}` : '';
        setHidden(badge, state.files.length === 0);

        const git = byId('webllm-project-git');
        if (git) {
            git.textContent = state.commit
                ? `main · ${state.commit.slice(0, 7)} · ${state.commits} ${state.commits === 1 ? 'commit' : 'commits'}`
                : state.files.length
                  ? 'main · not committed yet'
                  : '';
        }
        if (deploy) {
            deploy.disabled = state.busy || state.files.length === 0;
            deploy.setAttribute('aria-busy', state.busy ? 'true' : 'false');
        }
        const notice = byId('webllm-project-notice');
        if (notice) notice.textContent = state.notice || '';
        setHidden(notice, !state.notice);
        renderTree();
        renderCanvas();
    }

    renderCanvas();
    return { renderProject, openSnippet, openFile, closeCanvas, state: canvas, draft: () => draft };
}
