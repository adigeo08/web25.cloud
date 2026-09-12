/**
 * Just enough DOM for the Pages tab.
 *
 * Hand-built in the same spirit as the fake IndexedDB and deploy-DOM helpers:
 * it models the element surface `PagesPanel.js` actually touches — element
 * creation, classes, attributes, a delegated click listener and the handful of
 * selectors the panel queries — so the card rendering can be driven offline.
 * Markup drift in index.html is caught separately, by the tests that read the
 * template itself.
 */

/**
 * Match one compound selector: an optional tag, any number of classes and any
 * number of attribute checks. No combinators — nothing here needs them.
 *
 * @param {any} node
 * @param {string} selector
 */
function matches(node, selector) {
    const parts = selector.trim().match(/^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
    if (!parts) return false;
    const [, tag, classes, attrs] = parts;

    if (tag && node.tagName !== tag.toUpperCase()) return false;
    for (const name of (classes || '').split('.').filter(Boolean)) {
        if (!node.classList.contains(name)) return false;
    }
    for (const clause of (attrs || '').match(/\[[^\]]+\]/g) || []) {
        const [, name, value] = clause.slice(1, -1).match(/^([\w-]+)(?:="([^"]*)")?$/) || [];
        if (!name) return false;
        // `open` on a <details> is a property, not something the panel ever
        // writes as an attribute.
        const actual = name === 'open' && node.open !== undefined ? (node.open ? '' : null) : node.getAttribute(name);
        if (actual === null) return false;
        if (value !== undefined && actual !== value) return false;
    }
    return true;
}

class FakeNode {
    constructor(tagName) {
        this.tagName = `${tagName}`.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.listeners = new Map();
        this.style = {};
        this.dataset = {};
        this.focused = 0;
        this._class = '';
        this._text = '';

        const owner = this;
        this.classList = {
            add: (...names) => owner._setClasses([...owner._classes(), ...names]),
            remove: (...names) => owner._setClasses(owner._classes().filter((name) => !names.includes(name))),
            contains: (name) => owner._classes().includes(name),
            toggle(name, force) {
                const on = force === undefined ? !this.contains(name) : Boolean(force);
                if (on) this.add(name);
                else this.remove(name);
                return on;
            }
        };
    }

    _classes() {
        return this._class.split(/\s+/).filter(Boolean);
    }

    _setClasses(names) {
        this._class = [...new Set(names)].join(' ');
    }

    get className() {
        return this._class;
    }

    set className(value) {
        this._class = `${value || ''}`;
    }

    get textContent() {
        return this.children.length > 0 ? this.children.map((child) => child.textContent).join('') : this._text;
    }

    set textContent(value) {
        this.children.forEach((child) => {
            child.parentNode = null;
        });
        this.children = [];
        this._text = `${value}`;
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        this._text = '';
        return child;
    }

    setAttribute(name, value) {
        this.attributes.set(name, `${value}`);
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    focus() {
        this.focused += 1;
        this.ownerDocument().activeElement = this;
    }

    ownerDocument() {
        let node = this;
        while (node.parentNode) node = node.parentNode;
        return node._document || { activeElement: null };
    }

    descendants() {
        return this.children.flatMap((child) => [child, ...child.descendants()]);
    }

    querySelectorAll(selector) {
        return this.descendants().filter((node) => matches(node, selector));
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    closest(selector) {
        let node = this;
        while (node) {
            if (matches(node, selector)) return node;
            node = node.parentNode;
        }
        return null;
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }

    removeEventListener(type, handler) {
        const handlers = this.listeners.get(type) || [];
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
    }

    /** Fire an event on this node and let it bubble, the way a click does. */
    dispatch(type, event = {}) {
        const payload = { type, target: this, ...event };
        let node = this;
        while (node) {
            [...(node.listeners.get(type) || [])].forEach((handler) => handler(payload));
            node = node.parentNode;
        }
        return payload;
    }

    click() {
        return this.dispatch('click');
    }
}

/**
 * Install a document carrying the Pages tab's own elements.
 *
 * @returns {{ document: any, nodes: Record<string, any>, restore: () => void }}
 */
export function installFakePagesDom() {
    const previous = {
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        window: globalThis.window
    };

    const root = new FakeNode('body');
    const byId = new Map();

    const make = (tag, id, attrs = {}) => {
        const node = new FakeNode(tag);
        if (id) {
            node.setAttribute('id', id);
            byId.set(id, node);
        }
        Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
        root.appendChild(node);
        return node;
    };

    const nodes = {
        tabBtn: make('button', null, { 'data-tab': 'pages' }),
        browseTab: make('button', null, { 'data-tab': 'browse' }),
        panel: make('section', 'tab-pages'),
        list: make('div', 'pages-list'),
        count: make('span', 'pages-count'),
        modal: make('div', 'stop-seeding-modal'),
        title: make('h3', 'stop-seeding-title'),
        prompt: make('span', 'stop-seeding-prompt'),
        name: make('strong', 'stop-seeding-name'),
        detail: make('p', 'stop-seeding-detail'),
        confirm: make('button', 'stop-seeding-confirm'),
        cancel: make('button', 'stop-seeding-cancel'),
        close: make('button', 'stop-seeding-close')
    };
    nodes.modal.classList.add('modal', 'hidden');

    const document = {
        activeElement: null,
        createElement: (tag) => new FakeNode(tag),
        getElementById: (id) => byId.get(id) || null,
        querySelector: (selector) => root.querySelector(selector),
        querySelectorAll: (selector) => root.querySelectorAll(selector),
        listeners: new Map(),
        addEventListener(type, handler) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            const handlers = this.listeners.get(type) || [];
            const index = handlers.indexOf(handler);
            if (index >= 0) handlers.splice(index, 1);
        },
        /** Fire a document-level event, the way a keypress reaches the dialog. */
        press(key, extra = {}) {
            const event = { key, preventDefault() {}, ...extra };
            [...(this.listeners.get('keydown') || [])].forEach((handler) => handler(event));
            return event;
        }
    };
    root._document = document;

    globalThis.document = document;
    globalThis.HTMLElement = FakeNode;
    globalThis.window = { ...(previous.window || {}), confirm: () => false };

    return {
        document,
        nodes,
        restore() {
            globalThis.document = previous.document;
            globalThis.HTMLElement = previous.HTMLElement;
            globalThis.window = previous.window;
        }
    };
}
