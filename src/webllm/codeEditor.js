// @ts-check
/**
 * The canvas's code editor: CodeMirror 6, from esm.sh, with HTML, CSS and
 * JavaScript.
 *
 * CodeMirror is several packages that must share one copy of
 * `@codemirror/state`, `@codemirror/view` and the Lezer runtime — two copies
 * and extensions from one are not recognised by the other. Every module is
 * therefore imported with the same `?deps=` pin list, so esm.sh resolves them
 * all to the same files. Nothing is fetched until the canvas first shows code.
 *
 * Without the CDN the editor is a plain textarea with the same contract —
 * value, language, Save on Ctrl/⌘+S — and the canvas says so.
 */

export const CODEMIRROR_VERSIONS = Object.freeze({
    codemirror: '6.0.1',
    '@codemirror/state': '6.4.1',
    '@codemirror/view': '6.26.3',
    '@codemirror/language': '6.10.1',
    '@codemirror/commands': '6.5.0',
    '@codemirror/search': '6.5.6',
    '@codemirror/autocomplete': '6.16.0',
    '@codemirror/lint': '6.5.0',
    '@codemirror/lang-html': '6.4.9',
    '@codemirror/lang-css': '6.2.1',
    '@codemirror/lang-javascript': '6.2.2',
    '@codemirror/theme-one-dark': '6.1.2',
    '@lezer/common': '1.2.1',
    '@lezer/highlight': '1.2.0',
    '@lezer/lr': '1.4.0'
});

const DEPS = Object.entries(CODEMIRROR_VERSIONS)
    .filter(([name]) => name !== 'codemirror')
    .map(([name, version]) => `${name}@${version}`)
    .join(',');

/** @param {keyof typeof CODEMIRROR_VERSIONS} name */
export function codeMirrorUrl(name) {
    return `https://esm.sh/${name}@${CODEMIRROR_VERSIONS[name]}?deps=${DEPS}`;
}

const MODULES = /** @type {const} */ ([
    'codemirror',
    '@codemirror/state',
    '@codemirror/view',
    '@codemirror/lang-html',
    '@codemirror/lang-css',
    '@codemirror/lang-javascript',
    '@codemirror/theme-one-dark'
]);

export const CODEMIRROR_LOAD_TIMEOUT_MS = 20000;

/**
 * Import CodeMirror once per page. A failed or slow load rejects, and the next
 * editor asks again.
 * @param {(url: string) => Promise<any>} [importer]
 * @param {{ timeoutMs?: number }} [options]
 */
export function createCodeMirrorLoader(
    importer = (url) => import(/* @vite-ignore */ url),
    { timeoutMs = CODEMIRROR_LOAD_TIMEOUT_MS } = {}
) {
    /** @type {Promise<any>|null} */
    let loading = null;
    return () => {
        if (!loading) {
            /** @type {any} */
            let timer = null;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('CodeMirror took too long to load.')), timeoutMs);
            });
            loading = Promise.race([Promise.all(MODULES.map((name) => importer(codeMirrorUrl(name)))), timeout])
                .finally(() => clearTimeout(timer))
                .then((/** @type {any[]} */ [cm, state, view, html, css, js, theme]) => {
                    if (typeof view?.EditorView !== 'function' || !cm?.basicSetup) {
                        throw new Error('CodeMirror did not load.');
                    }
                    return { cm, state, view, html, css, js, theme };
                })
                .catch((error) => {
                    loading = null;
                    throw error;
                });
        }
        return loading;
    };
}

const loadShared = createCodeMirrorLoader();

/** The editor language for a file, by extension. @param {string} path */
export function editorLanguage(path) {
    const ext = `${path || ''}`.split('.').pop()?.toLowerCase() || '';
    if (ext === 'html' || ext === 'htm' || ext === 'svg' || ext === 'xml') return 'html';
    if (ext === 'css') return 'css';
    if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'webmanifest'].includes(ext)) return 'javascript';
    return 'text';
}

/**
 * @typedef {{ kind: 'codemirror'|'textarea', getValue: () => string,
 *             setValue: (doc: string, path: string) => void, focus: () => void, destroy: () => void }} CodeEditor
 */

/**
 * Put an editor in `parent`.
 * @param {HTMLElement} parent
 * @param {{ doc?: string, path?: string, onChange?: (value: string) => void, onSave?: () => void,
 *           load?: () => Promise<any> }} [options]
 * @returns {Promise<CodeEditor>}
 */
export async function createCodeEditor(
    parent,
    { doc = '', path = '', onChange = () => {}, onSave = () => {}, load = loadShared } = {}
) {
    let modules = null;
    try {
        modules = await load();
    } catch (_) {
        modules = null;
    }
    if (modules) {
        try {
            return codeMirrorEditor(parent, modules, { doc, path, onChange, onSave });
        } catch (error) {
            // Loaded but unusable — two copies of @codemirror/state, say. The
            // plain editor still edits and saves.
            console.warn('[codeEditor] CodeMirror could not start:', error);
            parent.textContent = '';
        }
    }
    return textareaEditor(parent, { doc, onChange, onSave });
}

/**
 * @param {HTMLElement} parent
 * @param {any} modules
 * @param {{ doc: string, path: string, onChange: (value: string) => void, onSave: () => void }} options
 * @returns {CodeEditor}
 */
function codeMirrorEditor(parent, { cm, state, view, html, css, js, theme }, { doc, path, onChange, onSave }) {
    const { EditorView, keymap } = view;
    const { EditorState, Compartment, Prec } = state;
    const language = new Compartment();
    /** @param {string} file */
    const languageFor = (file) => {
        const kind = editorLanguage(file);
        if (kind === 'html') return html.html();
        if (kind === 'css') return css.css();
        if (kind === 'javascript') return js.javascript();
        return [];
    };
    // The app's surfaces under One Dark's highlighting.
    const web25Theme = EditorView.theme(
        {
            '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)' },
            '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '0.8rem', lineHeight: '1.55' },
            '.cm-gutters': { backgroundColor: 'var(--surface-2)', borderRight: '1px solid var(--border)' },
            '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(255, 255, 255, 0.035)' },
            '&.cm-focused': { outline: 'none' }
        },
        { dark: true }
    );
    let silent = false;
    const editor = new EditorView({
        parent,
        state: EditorState.create({
            doc,
            extensions: [
                cm.basicSetup,
                Prec.highest(
                    keymap.of([
                        {
                            key: 'Mod-s',
                            preventDefault: true,
                            run: () => {
                                onSave();
                                return true;
                            }
                        }
                    ])
                ),
                theme.oneDark,
                web25Theme,
                language.of(languageFor(path)),
                EditorView.updateListener.of((/** @type {any} */ update) => {
                    if (update.docChanged && !silent) onChange(update.state.doc.toString());
                })
            ]
        })
    });
    return {
        kind: 'codemirror',
        getValue: () => editor.state.doc.toString(),
        setValue: (next, file) => {
            silent = true;
            editor.dispatch({
                changes: { from: 0, to: editor.state.doc.length, insert: next },
                effects: language.reconfigure(languageFor(file))
            });
            silent = false;
        },
        focus: () => editor.focus(),
        destroy: () => editor.destroy()
    };
}

/**
 * @param {HTMLElement} parent
 * @param {{ doc: string, onChange: (value: string) => void, onSave: () => void }} options
 * @returns {CodeEditor}
 */
function textareaEditor(parent, { doc, onChange, onSave }) {
    const area = parent.ownerDocument.createElement('textarea');
    area.className = 'webllm-canvas-textarea';
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Code');
    area.value = doc;
    area.addEventListener('input', () => onChange(area.value));
    area.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            onSave();
        } else if (event.key === 'Tab' && !event.shiftKey) {
            event.preventDefault();
            const { selectionStart: start, selectionEnd: end } = area;
            area.setRangeText('    ', start, end, 'end');
            onChange(area.value);
        }
    });
    parent.appendChild(area);
    return {
        kind: 'textarea',
        getValue: () => area.value,
        setValue: (next) => {
            area.value = next;
        },
        focus: () => area.focus(),
        destroy: () => area.remove()
    };
}
