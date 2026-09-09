/**
 * The slice of the Deploy tab's DOM that the deploy flow actually touches.
 *
 * Hand-built rather than parsed from index.html, in the same spirit as the
 * fake IndexedDB helper: it models the element surface the code uses, so the
 * state machine can be driven offline. Markup drift is caught separately, by
 * the tests that read index.html directly.
 */

function classList(node) {
    const set = new Set();
    node.className = set;
    return {
        add: (...names) => names.forEach((name) => set.add(name)),
        remove: (...names) => names.forEach((name) => set.delete(name)),
        contains: (name) => set.has(name),
        toggle: (name, force) => {
            const on = force === undefined ? !set.has(name) : Boolean(force);
            if (on) set.add(name);
            else set.delete(name);
            return on;
        },
        get size() {
            return set.size;
        },
        values: () => [...set]
    };
}

function element(extra = {}) {
    const node = {
        tagName: 'DIV',
        textContent: '',
        value: '',
        href: '',
        download: '',
        type: '',
        className: '',
        disabled: false,
        checked: false,
        open: false,
        selected: false,
        style: {},
        attributes: {},
        listeners: {},
        children: {},
        /** Child nodes appended by the UI modules, in order. */
        childNodes: [],
        ...extra
    };
    node.classList = classList(node);
    node.setAttribute = (name, value) => {
        node.attributes[name] = value;
    };
    node.getAttribute = (name) => (name in node.attributes ? node.attributes[name] : null);
    node.removeAttribute = (name) => {
        delete node.attributes[name];
    };
    node.addEventListener = (type, handler) => {
        (node.listeners[type] = node.listeners[type] || []).push(handler);
    };
    node.dispatch = (type, event = {}) => (node.listeners[type] || []).forEach((handler) => handler(event));
    node.querySelector = (selector) => node.children[selector] || null;
    node.appendChild = (child) => {
        node.childNodes.push(child);
        return child;
    };
    node.append = (...nodes) => nodes.forEach((child) => node.appendChild(child));
    node.removeChild = (child) => {
        node.childNodes = node.childNodes.filter((entry) => entry !== child);
        return child;
    };
    return node;
}

function stepChip(text, { note = null } = {}) {
    const chip = element();
    chip.children['.step-chip-text'] = element({ textContent: text });
    if (note !== null) chip.children['.step-chip-note'] = element({ textContent: note });
    return chip;
}

const CHIP_LABELS = [
    '1. Select files',
    '2. Preview & protect',
    '3. Build in-memory bundle',
    '4. Review payload',
    '5. Sign payload',
    '6. Deploy signed memory torrent',
    '7. Create GoFile mirror',
    '8. Live + mirrored'
];

/** The two optional steps are the ones that carry a note chip. */
const CHIPS_WITH_NOTES = new Set([1, 6]);

/** Install the fake deploy DOM as globals. Returns handles for assertions. */
export function installDeployDom() {
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    };

    const elements = new Map();
    const chips = CHIP_LABELS.map((label, index) => stepChip(label, { note: CHIPS_WITH_NOTES.has(index) ? 'Optional' : null }));
    const opened = [];
    const copied = [];

    globalThis.window = {
        location: {
            origin: 'https://web25.cloud',
            pathname: '/',
            href: 'https://web25.cloud/',
            hostname: 'web25.cloud',
            protocol: 'https:',
            search: ''
        },
        open: (url) => opened.push(url),
        addEventListener() {}
    };
    Object.defineProperty(globalThis, 'location', {
        value: globalThis.window.location,
        configurable: true,
        writable: true
    });
    Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: async (text) => copied.push(text) }, userAgent: 'node' },
        configurable: true,
        writable: true
    });
    const created = [];
    globalThis.document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, element());
            return elements.get(id);
        },
        createElement(tagName) {
            const node = element({ tagName: `${tagName}`.toUpperCase() });
            created.push(node);
            return node;
        },
        querySelectorAll(selector) {
            return selector === '#tab-publish .step-chip' ? chips : [];
        },
        querySelector: () => null,
        addEventListener() {}
    };

    return {
        elements,
        chips,
        opened,
        copied,
        created,
        get: (id) => globalThis.document.getElementById(id),
        text: (id) => globalThis.document.getElementById(id).textContent,
        /** The chip states, 1-based, as a readable array for assertions. */
        chipStates: () =>
            chips.map((chip) => {
                if (chip.classList.contains('step-active')) return 'active';
                if (chip.classList.contains('step-skipped')) return 'skipped';
                if (chip.classList.contains('step-failed')) return 'failed';
                if (chip.classList.contains('step-done')) return 'done';
                if (chip.classList.contains('step-locked')) return 'locked';
                return 'none';
            }),
        chipText: (step) => chips[step - 1].children['.step-chip-text'].textContent,
        chipNote: (step) => chips[step - 1].children['.step-chip-note']?.textContent ?? null,
        restore() {
            globalThis.window = previous.window;
            globalThis.document = previous.document;
            if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
        }
    };
}
