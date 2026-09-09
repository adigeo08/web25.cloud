// @ts-check
/**
 * Mapping a preview text selection back to the staged source.
 *
 * The publisher selects prose in the sandboxed preview; what gets encrypted has
 * to be the corresponding fragment of the *staged file*, resolved without
 * guessing. CSS selectors are not enough — they break on the first duplicated
 * class and say nothing about where inside an element a selection started — so
 * a locator carries four independent pieces of evidence:
 *
 *   • the staged file path,
 *   • the preview id of the element the selection is contained in,
 *   • the character offsets of the selection within that element's text,
 *   • the exact text, plus the text immediately before and after it.
 *
 * Resolution recomputes all of it against the retained authoring document and
 * refuses the selection unless every piece agrees. A locator that cannot be
 * resolved uniquely is rejected, never approximated.
 *
 * The locator recorded in the signed manifest is deliberately *not* this one:
 * `exact`, `prefix` and `suffix` are the plaintext the publisher is protecting,
 * so only the non-revealing structural half (`buildManifestLocator`) is
 * published.
 */

import {
    assignPreviewIds,
    createPlaceholderNode,
    createTextNode,
    elementsInDocumentOrder,
    parseAuthoringHtml,
    serializeAuthoringHtml,
    stripPreviewIds,
    textContentOf
} from './AuthoringDom.js';

export const TEXT_LOCATOR_SCHEMA = 'web25-text-locator-v1';
/** How much surrounding text a locator carries on each side. */
export const LOCATOR_CONTEXT_LENGTH = 32;

export class TextLocatorError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     */
    constructor(message, code = 'locator-unresolvable') {
        super(message);
        this.name = 'TextLocatorError';
        this.code = code;
    }
}

/**
 * Parse one staged HTML file into an authoring document and hand back the
 * preview markup for it: the same document with temporary node ids, which is
 * what the sandbox renders.
 *
 * @param {string} html
 * @param {string} path
 */
export function prepareAuthoringDocument(html, path) {
    const root = parseAuthoringHtml(html);
    const previewIndex = assignPreviewIds(root);
    return {
        path,
        root,
        previewIndex,
        previewHtml: serializeAuthoringHtml(root, { includePreviewIds: true })
    };
}

/**
 * The final markup for a staged file: preview ids removed, protected fragments
 * already replaced by placeholders.
 * @param {{ root: any }} document
 */
export function serializeStagedDocument(document) {
    stripPreviewIds(document.root);
    return serializeAuthoringHtml(document.root, { includePreviewIds: false });
}

/**
 * A structural, non-revealing description of where a fragment came from. This
 * is what the signed manifest records: it says *where* something was protected
 * without saying *what* it said.
 *
 * @param {{ containerPath: string, startOffset: number, endOffset: number }} input
 */
export function buildManifestLocator({ containerPath, startOffset, endOffset }) {
    return {
        type: TEXT_LOCATOR_SCHEMA,
        containerPath,
        startOffset,
        endOffset,
        length: endOffset - startOffset
    };
}

/**
 * `html[1]/body[1]/div[2]/p[1]` — position by tag among same-tag siblings, so
 * it survives class and id churn.
 * @param {any} element
 */
export function elementPath(element) {
    const parts = [];
    let node = element;
    while (node && node.parent) {
        const siblings = node.parent.children.filter((child) => child.type === 'element' && child.tag === node.tag);
        const position = siblings.indexOf(node) + 1;
        parts.unshift(`${node.tag}[${position}]`);
        node = node.parent;
    }
    return parts.join('/');
}

/**
 * Validate a locator as it arrives from the preview frame. Everything crossing
 * that boundary is untrusted input, so it is bounded and typed before use.
 * @param {any} raw
 */
export function normalizeSelectionLocator(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TextLocatorError('A selection locator must be an object.', 'locator-malformed');
    }
    const path = `${raw.path || ''}`.trim();
    const containerId = `${raw.containerId || ''}`.trim();
    const exact = typeof raw.exact === 'string' ? raw.exact : '';
    const prefix = typeof raw.prefix === 'string' ? raw.prefix : '';
    const suffix = typeof raw.suffix === 'string' ? raw.suffix : '';
    const startOffset = Number(raw.startOffset);
    const endOffset = Number(raw.endOffset);

    if (!path) throw new TextLocatorError('A selection locator must name its source file.', 'locator-no-path');
    if (!/^w\d+$/.test(containerId)) {
        throw new TextLocatorError('A selection locator must name a preview node id.', 'locator-no-container');
    }
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || startOffset < 0 || endOffset <= startOffset) {
        throw new TextLocatorError('A selection locator needs an ordered pair of text offsets.', 'locator-bad-offsets');
    }
    if (exact.length === 0) {
        throw new TextLocatorError('An empty selection cannot be protected.', 'locator-empty');
    }
    if (exact.length !== endOffset - startOffset) {
        throw new TextLocatorError('Selection length does not match its offsets.', 'locator-length-mismatch');
    }

    return { path, containerId, startOffset, endOffset, exact, prefix, suffix };
}

/**
 * The text nodes of a subtree with their offsets in the subtree's text content.
 * Raw-text elements (script, style) are skipped, exactly as `textContentOf`
 * skips them, so both sides count the same characters.
 * @param {any} element
 */
function textNodesWithOffsets(element) {
    /** @type {{ node: any, start: number, end: number }[]} */
    const out = [];
    let offset = 0;
    const walk = (node) => {
        if (node.type === 'text') {
            out.push({ node, start: offset, end: offset + node.value.length });
            offset += node.value.length;
            return;
        }
        if (node.type !== 'element' || node.rawText) return;
        for (const child of node.children) walk(child);
    };
    if (element.type === 'element' && !element.rawText) {
        for (const child of element.children) walk(child);
    }
    return out;
}

/**
 * @param {{ node: any, start: number, end: number }[]} entries
 * @param {number} offset
 * @param {'start'|'end'} edge
 */
function boundaryAt(entries, offset, edge) {
    for (const entry of entries) {
        if (edge === 'start' && offset >= entry.start && offset < entry.end) {
            return { node: entry.node, index: offset - entry.start };
        }
        if (edge === 'end' && offset > entry.start && offset <= entry.end) {
            return { node: entry.node, index: offset - entry.start };
        }
    }
    return null;
}

/**
 * Resolve a selection locator against the authoring document.
 *
 * @param {{ root: any, previewIndex: Map<string, any> }} document
 * @param {ReturnType<typeof normalizeSelectionLocator>} locator
 */
export function resolveSelectionLocator(document, locator) {
    const container = document.previewIndex.get(locator.containerId);
    if (!container) {
        throw new TextLocatorError(`Preview node ${locator.containerId} is not part of this document.`, 'locator-no-container');
    }

    const containerText = textContentOf(container);
    if (locator.endOffset > containerText.length) {
        throw new TextLocatorError('Selection runs past the end of its container.', 'locator-out-of-range');
    }

    const resolvedText = containerText.slice(locator.startOffset, locator.endOffset);
    if (resolvedText !== locator.exact) {
        throw new TextLocatorError('Selected text does not match the staged source at those offsets.', 'locator-text-mismatch');
    }

    // Prefix and suffix are the independent check: offsets alone could still be
    // pointing at a coincidentally identical run of text.
    const expectedPrefix = containerText.slice(Math.max(0, locator.startOffset - LOCATOR_CONTEXT_LENGTH), locator.startOffset);
    const expectedSuffix = containerText.slice(locator.endOffset, locator.endOffset + LOCATOR_CONTEXT_LENGTH);
    if (locator.prefix && locator.prefix !== expectedPrefix) {
        throw new TextLocatorError('Text before the selection does not match the staged source.', 'locator-prefix-mismatch');
    }
    if (locator.suffix && locator.suffix !== expectedSuffix) {
        throw new TextLocatorError('Text after the selection does not match the staged source.', 'locator-suffix-mismatch');
    }

    const entries = textNodesWithOffsets(container);
    const start = boundaryAt(entries, locator.startOffset, 'start');
    const end = boundaryAt(entries, locator.endOffset, 'end');
    if (!start || !end) {
        throw new TextLocatorError('Selection boundaries do not fall on staged text nodes.', 'locator-no-boundary');
    }

    return {
        container,
        containerPath: elementPath(container),
        startNode: start.node,
        startIndex: start.index,
        endNode: end.node,
        endIndex: end.index,
        startOffset: locator.startOffset,
        endOffset: locator.endOffset,
        exact: locator.exact
    };
}

/**
 * Split the container subtree into the part that stays in the published file
 * and the fragment that gets encrypted, inserting the placeholder exactly where
 * the fragment was.
 *
 * @param {ReturnType<typeof resolveSelectionLocator>} resolved
 * @param {string} assetId
 * @returns {{ fragmentHtml: string, placeholder: any }}
 */
export function replaceRangeWithPlaceholder(resolved, assetId) {
    const placeholder = createPlaceholderNode(assetId);
    const withPlaceholder = new Set();

    const ctx = {
        state: /** @type {'before'|'inside'|'after'} */ ('before'),
        startNode: resolved.startNode,
        startIndex: resolved.startIndex,
        endNode: resolved.endNode,
        endIndex: resolved.endIndex,
        placeholder,
        withPlaceholder
    };

    /**
     * @param {any} node
     * @returns {{ kept: any[], taken: any[] }}
     */
    const partition = (node) => {
        if (node.type === 'text') return partitionText(node, ctx);

        if (node.type !== 'element' || node.rawText) {
            // Comments, doctypes and raw-text elements are atomic: they belong
            // wholly to whichever side of the boundary they sit on.
            return ctx.state === 'inside' ? { kept: [], taken: [node] } : { kept: [node], taken: [] };
        }

        const enterState = ctx.state;
        /** @type {any[]} */
        const kept = [];
        /** @type {any[]} */
        const taken = [];
        for (const child of node.children) {
            const result = partition(child);
            kept.push(...result.kept);
            taken.push(...result.taken);
        }
        const exitState = ctx.state;

        const holdsPlaceholder = kept.some((child) => child === placeholder || withPlaceholder.has(child));
        const fullyInside = enterState === 'inside' && exitState === 'inside' && !holdsPlaceholder;
        const emptiedByRange = !holdsPlaceholder && kept.length === 0 && taken.length > 0;

        if (fullyInside || emptiedByRange) {
            const takenClone = cloneElement(node, taken.length > 0 ? taken : node.children);
            return { kept: [], taken: [takenClone] };
        }

        node.children = kept;
        for (const child of kept) if (child && typeof child === 'object') child.parent = node;

        if (holdsPlaceholder) {
            // The placeholder sits *inside* this element, so the fragment will
            // be restored inside it too. Re-wrapping the taken content in a
            // clone of this element would duplicate the wrapper on decrypt.
            withPlaceholder.add(node);
            return { kept: [node], taken };
        }

        return { kept: [node], taken: taken.length > 0 ? [cloneElement(node, taken)] : [] };
    };

    const result = partition(resolved.container);
    if (ctx.state !== 'after') {
        throw new TextLocatorError('Selection could not be applied to the staged source.', 'locator-unapplied');
    }
    if (result.taken.length === 0) {
        throw new TextLocatorError('Selection resolved to no content.', 'locator-empty');
    }

    const fragmentHtml = result.taken.map((node) => serializeAuthoringHtml(node, { includePreviewIds: false })).join('');
    return { fragmentHtml, placeholder };
}

/**
 * @param {any} node
 * @param {any} ctx
 * @returns {{ kept: any[], taken: any[] }}
 */
function partitionText(node, ctx) {
    const isStart = node === ctx.startNode;
    const isEnd = node === ctx.endNode;

    if (ctx.state === 'before' && !isStart) return { kept: [node], taken: [] };
    if (ctx.state === 'after') return { kept: [node], taken: [] };

    if (ctx.state === 'before' && isStart) {
        const head = node.value.slice(0, ctx.startIndex);
        const tailStart = isEnd ? ctx.endIndex : node.value.length;
        const body = node.value.slice(ctx.startIndex, tailStart);
        const tail = isEnd ? node.value.slice(ctx.endIndex) : '';

        ctx.state = isEnd ? 'after' : 'inside';

        const kept = [];
        if (head) kept.push(createTextNode(head));
        kept.push(ctx.placeholder);
        if (tail) kept.push(createTextNode(tail));
        return { kept, taken: body ? [createTextNode(body)] : [] };
    }

    // state === 'inside'
    if (isEnd) {
        ctx.state = 'after';
        const body = node.value.slice(0, ctx.endIndex);
        const tail = node.value.slice(ctx.endIndex);
        return { kept: tail ? [createTextNode(tail)] : [], taken: body ? [createTextNode(body)] : [] };
    }
    return { kept: [], taken: [node] };
}

/**
 * @param {any} element
 * @param {any[]} children
 */
function cloneElement(element, children) {
    const clone = {
        type: 'element',
        tag: element.tag,
        rawOpen: element.rawOpen,
        rawClose: element.rawClose,
        children,
        parent: null,
        previewId: null,
        rawText: element.rawText
    };
    for (const child of children) if (child && typeof child === 'object') child.parent = clone;
    return clone;
}

/**
 * Reject selections that overlap each other: two protected fragments covering
 * the same characters could not both be restored, so this is a rejection rather
 * than a merge.
 * @param {{ containerId: string, startOffset: number, endOffset: number }[]} locators
 */
export function assertNoOverlappingSelections(locators) {
    const byContainer = new Map();
    for (const locator of locators) {
        const list = byContainer.get(locator.containerId) || [];
        list.push(locator);
        byContainer.set(locator.containerId, list);
    }
    for (const [containerId, list] of byContainer) {
        const sorted = [...list].sort((left, right) => left.startOffset - right.startOffset);
        for (let index = 1; index < sorted.length; index += 1) {
            if (sorted[index].startOffset < sorted[index - 1].endOffset) {
                throw new TextLocatorError(
                    `Two protected selections overlap inside ${containerId}.`,
                    'locator-overlap'
                );
            }
        }
    }
}

/**
 * Apply every resolved selection to one document.
 *
 * Selections are resolved against the pristine document first and only then
 * applied, back to front, so an earlier fragment's offsets are never shifted by
 * a later replacement.
 *
 * @param {{ root: any, previewIndex: Map<string, any> }} document
 * @param {{ locator: any, assetId: string }[]} selections
 * @returns {{ assetId: string, fragmentHtml: string, containerPath: string, locator: any }[]}
 */
export function applyProtectedSelections(document, selections) {
    const normalized = selections.map((selection) => ({
        assetId: selection.assetId,
        locator: normalizeSelectionLocator(selection.locator)
    }));
    assertNoOverlappingSelections(normalized.map((entry) => entry.locator));

    const documentOrder = new Map(elementsInDocumentOrder(document.root).map((element, index) => [element, index]));
    const resolved = normalized.map((entry) => ({
        assetId: entry.assetId,
        locator: entry.locator,
        resolution: resolveSelectionLocator(document, entry.locator)
    }));

    const applyOrder = [...resolved].sort((left, right) => {
        const leftIndex = documentOrder.get(left.resolution.container) ?? 0;
        const rightIndex = documentOrder.get(right.resolution.container) ?? 0;
        if (leftIndex !== rightIndex) return rightIndex - leftIndex;
        return right.resolution.startOffset - left.resolution.startOffset;
    });

    const out = [];
    for (const entry of applyOrder) {
        const { fragmentHtml } = replaceRangeWithPlaceholder(entry.resolution, entry.assetId);
        out.push({
            assetId: entry.assetId,
            fragmentHtml,
            containerPath: entry.resolution.containerPath,
            locator: buildManifestLocator({
                containerPath: entry.resolution.containerPath,
                startOffset: entry.resolution.startOffset,
                endOffset: entry.resolution.endOffset
            })
        });
    }

    // Report in document order, which is the order the publisher sees them in.
    return out.reverse();
}
