// @ts-check
/**
 * The small part of Markdown a chat reply needs, drawn as DOM.
 *
 *   ```lang … ```   a code block with its language and a Copy button; a block
 *                   still being streamed (no closing fence yet) is drawn as
 *                   code up to the end of the text
 *   `code`          inline code
 *   **bold**        bold
 *   # / ## / ###    a heading line
 *
 * Everything else stays the text it was: the bubble keeps `white-space:
 * pre-wrap`, so lines, lists and blank lines show as written, and a reply
 * without any of the above reads exactly as before.
 *
 * Model output is untrusted. Nothing here parses HTML: every piece of text is
 * set with `textContent` or a text node, and a language label is reduced to a
 * few safe characters before it is shown or used as a class.
 */

/**
 * @typedef {{ type: 'text', text: string } |
 *           { type: 'code', lang: string, code: string, closed: boolean }} ReplyBlock
 */

/** A fence line: three or more backticks, then an optional language. */
const FENCE = /^[ \t]{0,3}(`{3,})[ \t]*([^\s`]*)[^\n`]*$/;

/** @param {string} lang */
export function safeLanguage(lang) {
    return `${lang || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9+#.-]/g, '')
        .slice(0, 20);
}

/**
 * Split a reply into text and fenced code blocks.
 * @param {string} content
 * @returns {ReplyBlock[]}
 */
export function splitReply(content) {
    /** @type {ReplyBlock[]} */
    const blocks = [];
    const lines = `${content || ''}`.split('\n');
    /** @type {string[]} */
    let text = [];
    /** @type {{ fence: string, lang: string, lines: string[] }|null} */
    let code = null;

    const flushText = () => {
        if (text.length > 0) blocks.push({ type: 'text', text: text.join('\n') });
        text = [];
    };

    for (const line of lines) {
        const fence = line.match(FENCE);
        if (code) {
            // A closing fence is at least as long as the opening one, with nothing after it.
            if (fence && fence[1].length >= code.fence.length && !fence[2]) {
                blocks.push({ type: 'code', lang: code.lang, code: code.lines.join('\n'), closed: true });
                code = null;
            } else {
                code.lines.push(line);
            }
            continue;
        }
        if (fence) {
            flushText();
            code = { fence: fence[1], lang: safeLanguage(fence[2]), lines: [] };
            continue;
        }
        text.push(line);
    }
    if (code) blocks.push({ type: 'code', lang: code.lang, code: code.lines.join('\n'), closed: false });
    flushText();
    // The line breaks around a block belong to the block: drop the blank edges
    // of the text beside it so a code block does not sit between empty lines.
    return blocks
        .map((block, index) => {
            if (block.type !== 'text') return block;
            let value = block.text;
            if (index > 0 && blocks[index - 1].type === 'code') value = value.replace(/^\n+/, '');
            if (index < blocks.length - 1 && blocks[index + 1].type === 'code') value = value.replace(/\n+$/, '');
            return { ...block, text: value };
        })
        .filter((block) => block.type === 'code' || block.text !== '');
}

/** `code` and **bold**, in one pass, left to right. */
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*/g;

/**
 * Append a line of text with its inline code and bold.
 * @param {Document} doc
 * @param {Node} parent
 * @param {string} text
 */
function appendInline(doc, parent, text) {
    let last = 0;
    for (const match of text.matchAll(INLINE)) {
        const index = match.index ?? 0;
        if (index > last) parent.appendChild(doc.createTextNode(text.slice(last, index)));
        if (match[1] !== undefined) {
            const code = doc.createElement('code');
            code.className = 'webllm-inline-code';
            code.textContent = match[1];
            parent.appendChild(code);
        } else {
            // Bold may hold inline code: **`debounce`**.
            const strong = doc.createElement('strong');
            appendInline(doc, strong, match[2]);
            parent.appendChild(strong);
        }
        last = index + match[0].length;
    }
    if (last < text.length) parent.appendChild(doc.createTextNode(text.slice(last)));
}

/**
 * @param {Document} doc
 * @param {Node} parent
 * @param {string} text
 */
function appendText(doc, parent, text) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        if (heading) {
            const el = doc.createElement('span');
            el.className = `webllm-md-heading webllm-md-h${heading[1].length}`;
            appendInline(doc, el, heading[2]);
            parent.appendChild(el);
        } else {
            appendInline(doc, parent, line);
        }
        if (index < lines.length - 1) parent.appendChild(doc.createTextNode('\n'));
    });
}

/**
 * @param {Document} doc
 * @param {{ lang: string, code: string, closed: boolean }} block
 */
function createCodeBlock(doc, block) {
    const figure = doc.createElement('div');
    figure.className = `webllm-code${block.closed ? '' : ' is-open'}`;
    const head = doc.createElement('div');
    head.className = 'webllm-code-head';
    const label = doc.createElement('span');
    label.className = 'webllm-code-lang';
    label.textContent = block.lang || 'code';
    const copy = doc.createElement('button');
    copy.type = 'button';
    copy.className = 'webllm-code-copy';
    copy.dataset.copyCode = '';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', `Copy ${block.lang || 'code'} snippet`);
    head.append(label, copy);
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    if (block.lang) code.className = `language-${block.lang}`;
    code.textContent = block.code;
    pre.appendChild(code);
    figure.append(head, pre);
    return figure;
}

/**
 * Draw `content` into `body`, replacing what was there.
 * @param {HTMLElement} body
 * @param {string} content
 */
export function renderReply(body, content) {
    const doc = body.ownerDocument;
    body.textContent = '';
    for (const block of splitReply(content)) {
        if (block.type === 'code') body.appendChild(createCodeBlock(doc, block));
        else appendText(doc, body, block.text);
    }
}

/**
 * The code a Copy button belongs to.
 * @param {Element} button
 */
export function codeForCopyButton(button) {
    return button.closest('.webllm-code')?.querySelector('pre code')?.textContent ?? '';
}
