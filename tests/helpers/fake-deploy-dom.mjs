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
        textContent: '',
        href: '',
        download: '',
        disabled: false,
        checked: false,
        open: false,
        style: {},
        attributes: {},
        listeners: {},
        children: {},
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
    '2. Build in-memory bundle',
    '3. Review payload',
    '4. Sign payload',
    '5. Deploy signed memory torrent',
    '6. Create GoFile mirror',
    '7. Live + mirrored'
];

/** Install the fake deploy DOM as globals. Returns handles for assertions. */
export function installDeployDom() {
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    };

    const elements = new Map();
    const chips = CHIP_LABELS.map((label, index) => stepChip(label, { note: index === 5 ? 'Optional' : null }));
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
    globalThis.document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, element());
            return elements.get(id);
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
