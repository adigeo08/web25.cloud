// @ts-check
/**
 * A small, round-trip-faithful HTML tree used for authoring protected
 * fragments.
 *
 * The publisher selects text in a rendered preview, and that selection has to
 * come back to the *staged source* — the exact bytes that will be hashed,
 * signed and seeded. Re-serialising through the browser's own DOM would not do:
 * it normalises attribute quoting, drops duplicate attributes, injects implied
 * elements, and would make the published file differ from the file the
 * publisher chose, in ways that vary by browser.
 *
 * So each node keeps the raw source text of its own tags. A document that is
 * parsed and serialised again without edits comes back byte for byte, and the
 * only differences in a protected build are the fragments that were actually
 * replaced.
 *
 * Preview-only node ids (`data-web25-node`) are added for rendering and removed
 * before the final files are built; they never reach a published bundle.
 */

export const PREVIEW_ID_ATTRIBUTE = 'data-web25-node';

const VOID_ELEMENTS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr'
]);

/**
 * Elements whose content is text, not markup.
 *
 * These are also the subtrees excluded from selectable text: the preview frame
 * skips exactly this set when it counts offsets, so both sides count the same
 * characters. Keep the two in step — `SKIP_TEXT_TAGS` in `SandboxBootstrap.js`.
 */
export const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
};

export class AuthoringDomError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthoringDomError';
    }
}

/**
 * @typedef {{
 *   type: 'element', tag: string, rawOpen: string, rawClose: string,
 *   children: AuthoringNode[], parent: AuthoringNode | null,
 *   previewId: string | null, rawText: boolean
 * }} AuthoringElement
 * @typedef {{ type: 'text', value: string, raw: string, parent: AuthoringNode | null }} AuthoringText
 * @typedef {{ type: 'raw', raw: string, parent: AuthoringNode | null }} AuthoringRaw
 * @typedef {{ type: 'placeholder', assetId: string, parent: AuthoringNode | null }} AuthoringPlaceholder
 * @typedef {AuthoringElement | AuthoringText | AuthoringRaw | AuthoringPlaceholder} AuthoringNode
 */

/** Decode the entity references a browser's `textContent` would have resolved. */
export function decodeEntities(text) {
    return `${text}`.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
        if (body[0] === '#') {
            const codePoint =
                body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
            try {
                return String.fromCodePoint(codePoint);
            } catch (_) {
                return match;
            }
        }
        const named = NAMED_ENTITIES[body.toLowerCase()];
        return named === undefined ? match : named;
    });
}

/** Re-encode text that is being emitted as markup rather than copied verbatim. */
export function encodeText(text) {
    return `${text}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Parse HTML into the authoring tree.
 *
 * Malformed input is tolerated rather than repaired: a stray close tag is
 * dropped and an unclosed element simply ends at EOF. Because every node keeps
 * its own raw text, tolerating a mistake never rewrites it.
 *
 * @param {string} html
 * @returns {AuthoringElement} a synthetic root whose children are the document
 */
export function parseAuthoringHtml(html) {
    const source = `${html}`;
    /** @type {AuthoringElement} */
    const root = {
        type: 'element',
        tag: '#root',
        rawOpen: '',
        rawClose: '',
        children: [],
        parent: null,
        previewId: null,
        rawText: false
    };
    /** @type {AuthoringElement[]} */
    const stack = [root];
    let index = 0;

    const pushNode = (node) => {
        const parent = stack[stack.length - 1];
        node.parent = parent;
        parent.children.push(node);
    };

    const pushText = (raw) => {
        if (!raw) return;
        pushNode({ type: 'text', value: decodeEntities(raw), raw, parent: null });
    };

    while (index < source.length) {
        const next = source.indexOf('<', index);
        if (next === -1) {
            pushText(source.slice(index));
            break;
        }
        if (next > index) pushText(source.slice(index, next));

        // Comments, CDATA, doctype and processing instructions travel verbatim.
        if (source.startsWith('<!--', next)) {
            const end = source.indexOf('-->', next + 4);
            const stop = end === -1 ? source.length : end + 3;
            pushNode({ type: 'raw', raw: source.slice(next, stop), parent: null });
            index = stop;
            continue;
        }
        if (source.startsWith('<!', next) || source.startsWith('<?', next)) {
            const end = source.indexOf('>', next);
            const stop = end === -1 ? source.length : end + 1;
            pushNode({ type: 'raw', raw: source.slice(next, stop), parent: null });
            index = stop;
            continue;
        }

        if (source.startsWith('</', next)) {
            const end = source.indexOf('>', next);
            const stop = end === -1 ? source.length : end + 1;
            const tag = source
                .slice(next + 2, end === -1 ? source.length : end)
                .trim()
                .toLowerCase();
            const depth = findOpenIndex(stack, tag);
            if (depth > 0) {
                stack[depth].rawClose = source.slice(next, stop);
                stack.length = depth;
            }
            // A close tag with no matching open is dropped, exactly as browsers do.
            index = stop;
            continue;
        }

        const tagMatch = /^<([a-zA-Z][a-zA-Z0-9:_.-]*)/.exec(source.slice(next));
        if (!tagMatch) {
            // A bare "<" that starts no tag is literal text.
            pushText('<');
            index = next + 1;
            continue;
        }

        const end = findTagEnd(source, next);
        const rawOpen = source.slice(next, end);
        const tag = tagMatch[1].toLowerCase();
        const selfClosing = /\/>$/.test(rawOpen) || VOID_ELEMENTS.has(tag);

        /** @type {AuthoringElement} */
        const element = {
            type: 'element',
            tag,
            rawOpen,
            rawClose: '',
            children: [],
            parent: null,
            previewId: null,
            rawText: RAW_TEXT_ELEMENTS.has(tag)
        };
        pushNode(element);
        index = end;

        if (selfClosing) continue;

        if (element.rawText) {
            // Raw-text elements swallow everything up to their own close tag,
            // so a "<" inside a script never opens an element.
            const closeIndex = findRawTextClose(source, index, tag);
            const textEnd = closeIndex === -1 ? source.length : closeIndex;
            const text = source.slice(index, textEnd);
            if (text) {
                element.children.push({ type: 'text', value: text, raw: text, parent: element });
            }
            if (closeIndex === -1) {
                index = source.length;
            } else {
                const closeEnd = source.indexOf('>', closeIndex);
                const stop = closeEnd === -1 ? source.length : closeEnd + 1;
                element.rawClose = source.slice(closeIndex, stop);
                index = stop;
            }
            continue;
        }

        stack.push(element);
    }

    return root;
}

/**
 * @param {AuthoringElement[]} stack
 * @param {string} tag
 * @returns {number} index in the stack, or -1
 */
function findOpenIndex(stack, tag) {
    for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tag === tag) return depth;
    }
    return -1;
}

/**
 * Find the ">" that ends an open tag, skipping quoted attribute values so that
 * `<a title="a > b">` is not cut in half.
 * @param {string} source
 * @param {number} start index of "<"
 */
function findTagEnd(source, start) {
    let quote = '';
    for (let index = start + 1; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '>') return index + 1;
    }
    return source.length;
}

/**
 * @param {string} source
 * @param {number} from
 * @param {string} tag
 */
function findRawTextClose(source, from, tag) {
    const pattern = new RegExp(`</${tag}\\s*>`, 'i');
    const rest = source.slice(from);
    const match = pattern.exec(rest);
    return match ? from + match.index : -1;
}

// ─── traversal ───────────────────────────────────────────────────────────

/**
 * Every element in document order, root excluded.
 * @param {AuthoringElement} root
 * @returns {AuthoringElement[]}
 */
export function elementsInDocumentOrder(root) {
    /** @type {AuthoringElement[]} */
    const out = [];
    const walk = (node) => {
        for (const child of node.children) {
            if (child.type === 'element') {
                out.push(child);
                walk(child);
            }
        }
    };
    walk(root);
    return out;
}

/**
 * Assign preview-only ids to every element, in document order.
 * @param {AuthoringElement} root
 * @returns {Map<string, AuthoringElement>}
 */
export function assignPreviewIds(root) {
    /** @type {Map<string, AuthoringElement>} */
    const index = new Map();
    elementsInDocumentOrder(root).forEach((element, position) => {
        // Raw-text elements have no selectable rendered text of their own.
        const id = `w${position}`;
        element.previewId = id;
        index.set(id, element);
    });
    return index;
}

/** Drop every preview-only id, so the built files carry none. */
export function stripPreviewIds(root) {
    for (const element of elementsInDocumentOrder(root)) {
        element.previewId = null;
    }
}

/**
 * The rendered text of a subtree, matching what `Node.textContent` would give
 * for the same markup: entity references resolved, raw-text element bodies
 * (script, style) excluded, because they are never selectable prose.
 *
 * @param {AuthoringNode} node
 * @returns {string}
 */
export function textContentOf(node) {
    if (node.type === 'text') return node.value;
    if (node.type !== 'element') return '';
    if (node.rawText) return '';
    let text = '';
    for (const child of node.children) text += textContentOf(child);
    return text;
}

/**
 * Serialise the tree back to HTML.
 *
 * Unmodified nodes emit their original source, so a parse/serialise round trip
 * is byte-identical. Only nodes carrying a preview id (when asked for) or nodes
 * created during protection are rebuilt.
 *
 * @param {AuthoringNode} node
 * @param {{ includePreviewIds?: boolean }} [options]
 * @returns {string}
 */
export function serializeAuthoringHtml(node, options = {}) {
    const includePreviewIds = Boolean(options.includePreviewIds);

    if (node.type === 'text') return node.raw;
    if (node.type === 'raw') return node.raw;
    if (node.type === 'placeholder') {
        return `<web25-protected data-asset-id="${node.assetId}"></web25-protected>`;
    }

    let html = '';
    if (node.tag !== '#root') {
        html += includePreviewIds && node.previewId ? openTagWithPreviewId(node) : node.rawOpen;
    }
    for (const child of node.children) html += serializeAuthoringHtml(child, options);
    if (node.tag !== '#root') html += node.rawClose;
    return html;
}

/**
 * @param {AuthoringElement} element
 * @returns {string}
 */
function openTagWithPreviewId(element) {
    const raw = element.rawOpen;
    const selfClosing = /\/>$/.test(raw);
    const body = raw.slice(1, selfClosing ? raw.length - 2 : raw.length - 1).replace(/\s+$/, '');
    return `<${body} ${PREVIEW_ID_ATTRIBUTE}="${element.previewId}"${selfClosing ? ' />' : '>'}`;
}

/**
 * A protected placeholder node.
 * @param {string} assetId
 * @returns {AuthoringPlaceholder}
 */
export function createPlaceholderNode(assetId) {
    return { type: 'placeholder', assetId, parent: null };
}

/**
 * A text node created from a slice of decoded text (so it must be re-encoded).
 * @param {string} value
 * @returns {AuthoringText}
 */
export function createTextNode(value) {
    return { type: 'text', value, raw: encodeText(value), parent: null };
}
