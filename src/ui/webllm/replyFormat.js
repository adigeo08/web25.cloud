// @ts-check
/**
 * The small part of Markdown a chat reply needs, drawn as DOM.
 *
 *   ```lang … ```   a code block with its language and a Copy button, also in
 *                   the looser forms a small model writes (see splitReply); a
 *                   block still being streamed (no closing fence yet) is drawn
 *                   as code up to the end of the text
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

/** @param {string} lang */
export function safeLanguage(lang) {
    return `${lang || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9+#.-]/g, '')
        .slice(0, 20);
}

/**
 * Where the first run of three or more backticks starts in `line`, and how
 * long it is; null when there is none.
 * @param {string} line
 * @param {number} [from]
 * @returns {{ index: number, length: number }|null}
 */
function findFence(line, from = 0) {
    const index = line.indexOf('```', from);
    if (index < 0) return null;
    let end = index;
    while (line[end] === '`') end += 1;
    return { index, length: end - index };
}

/**
 * Split a reply into text and fenced code blocks.
 *
 * Standard fences, and the ways a small model actually writes them:
 *
 *   Here is the code: ```js      a fence opening at the end of a line of text
 *   ```js const x = 1;           code on the fence line itself
 *     ```html … ```              a fence indented inside a list (the indent is
 *                                taken off the code lines)
 *   }```                         the closing fence glued to the last line
 *   ``` That is all.             text after the closing fence
 *   Run ```npm install``` now.   a whole block on one line
 *
 * A block still being streamed (no closing fence yet) is code up to the end.
 *
 * @param {string} content
 * @returns {ReplyBlock[]}
 */
export function splitReply(content) {
    /** @type {ReplyBlock[]} */
    const blocks = [];
    /** @type {string[]} */
    let text = [];
    /** @type {{ fence: number, lang: string, indent: string, lines: string[] }|null} */
    let code = null;

    const flushText = () => {
        if (text.length > 0) blocks.push({ type: 'text', text: text.join('\n') });
        text = [];
    };
    const closeCode = () => {
        if (!code) return;
        blocks.push({ type: 'code', lang: code.lang, code: code.lines.join('\n'), closed: true });
        code = null;
    };

    /** A line outside a code block. @param {string} line */
    const readText = (line) => {
        const fence = findFence(line);
        if (!fence) {
            text.push(line);
            return;
        }
        const before = line.slice(0, fence.index);
        const rest = line.slice(fence.index + fence.length);

        // A whole block on one line: ```npm install```.
        const closing = findFence(rest);
        if (closing && closing.length >= fence.length) {
            const inner = rest.slice(0, closing.index).trim();
            const after = rest.slice(closing.index + closing.length).trim();
            if (before.trim()) text.push(before.trimEnd());
            if (inner) {
                flushText();
                blocks.push({ type: 'code', lang: '', code: inner, closed: true });
            }
            if (after) readText(after);
            return;
        }

        // An opening fence. A word right after it is the language; anything
        // else on the line is the first line of code.
        if (before.trim()) text.push(before.trimEnd());
        flushText();
        const adjacent = rest.length > 0 && rest[0] !== ' ' && rest[0] !== '\t';
        const trimmed = rest.trim();
        const space = trimmed.search(/\s/);
        const word = space < 0 ? trimmed : trimmed.slice(0, space);
        const remainder = space < 0 ? '' : trimmed.slice(space).trim();
        // "``` js" names a language too; "``` const x = 1" is code.
        const named = adjacent || !remainder;
        code = {
            fence: fence.length,
            lang: named ? safeLanguage(word) : '',
            indent: before.trim() ? '' : before,
            lines: []
        };
        const first = named ? remainder : trimmed;
        if (first) code.lines.push(first);
    };

    /** A line inside a code block. @param {string} raw */
    const readCode = (raw) => {
        if (!code) return;
        const line = code.indent && raw.startsWith(code.indent) ? raw.slice(code.indent.length) : raw;
        const trimmed = line.trim();
        const fence = findFence(trimmed);
        if (fence && fence.length >= code.fence) {
            const before = trimmed.slice(0, fence.index);
            const after = trimmed.slice(fence.index + fence.length);
            // ``` on its own: the block ends.
            if (!before && !after.trim()) {
                closeCode();
                return;
            }
            // }``` — the last line of code, then the fence.
            if (before && !after.trim()) {
                code.lines.push(line.trimEnd().slice(0, -fence.length).trimEnd());
                closeCode();
                return;
            }
            // ``` That is all. — the block ends and the text goes on.
            if (!before && /^\s/.test(after)) {
                closeCode();
                readText(after.trim());
                return;
            }
        }
        // Anything else, "```js" included, is a line of code.
        code.lines.push(line);
    };

    for (const line of `${content || ''}`.split('\n')) {
        if (code) readCode(line);
        else readText(line);
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
 * @typedef {{ index: number, filename: string|null, suggested: string|null, code?: string }} CodeFileName
 */

/**
 * The file controls of one block: its name, editable, and Save to project.
 * @param {Document} doc
 * @param {CodeFileName} file
 */
function createFileControls(doc, file) {
    const wrap = doc.createElement('span');
    wrap.className = 'webllm-code-file';
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'webllm-code-name';
    input.dataset.codeName = '';
    input.value = file.filename || '';
    input.placeholder = file.suggested || 'file name';
    input.maxLength = 120;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'File name for this snippet');
    const save = doc.createElement('button');
    save.type = 'button';
    save.className = 'webllm-code-save';
    save.dataset.saveCode = `${file.index}`;
    save.textContent = 'Save to project';
    save.setAttribute('aria-label', 'Save this snippet to the conversation’s project');
    const preview = doc.createElement('button');
    preview.type = 'button';
    preview.className = 'webllm-code-preview';
    preview.dataset.openCanvas = `${file.index}`;
    preview.textContent = 'Preview';
    preview.setAttribute('aria-label', 'Open this snippet in the canvas, to preview and edit it');
    wrap.append(input, preview, save);
    return wrap;
}

/**
 * @param {Document} doc
 * @param {{ lang: string, code: string, closed: boolean }} block
 * @param {CodeFileName|null} [file] file controls for this block, when the
 *   reply's code can be saved to a project
 */
function createCodeBlock(doc, block, file = null) {
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
    if (file) head.append(label, createFileControls(doc, file), copy);
    else head.append(label, copy);
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    if (block.lang) code.className = `language-${block.lang}`;
    // A file name written as the first line (```html index.html) is shown in
    // the name field, so the block shows the file's code without it.
    code.textContent = file && typeof file.code === 'string' ? file.code : block.code;
    pre.appendChild(code);
    figure.append(head, pre);
    return figure;
}

/**
 * Draw `content` into `body`, replacing what was there.
 * @param {HTMLElement} body
 * @param {string} content
 * @param {{ files?: CodeFileName[]|null }} [options] `files` gives code blocks
 *   their file controls, matched by `index` (the block's place among the
 *   reply's code blocks); without it a block has only Copy
 */
export function renderReply(body, content, { files = null } = {}) {
    const doc = body.ownerDocument;
    body.textContent = '';
    let index = -1;
    for (const block of splitReply(content)) {
        if (block.type === 'code') {
            index += 1;
            const file = files?.find((entry) => entry.index === index) || null;
            body.appendChild(createCodeBlock(doc, block, file));
        } else appendText(doc, body, block.text);
    }
}

/**
 * The code a Copy button belongs to.
 * @param {Element} button
 */
export function codeForCopyButton(button) {
    return button.closest('.webllm-code')?.querySelector('pre code')?.textContent ?? '';
}
