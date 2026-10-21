// @ts-check
import { Marked } from '../../../scripts/marked.esm.js';

/**
 * Markdown → HTML for the About page chapters (content/about/*.md).
 *
 * The renderer is the locally bundled `scripts/marked.esm.js` — no CDN — set up
 * so a chapter file reads naturally on its own and still produces the markup
 * the About card styles expect:
 *
 *   - `# Title` becomes the card's `<h3>` and `##` its `<h4>` (offset by two), so
 *     a chapter file starts with a normal top-level heading.
 *   - A `::: feature-grid` block holds a bullet list and becomes
 *     `<div class="feature-grid">` of `<div class="feature">` items.
 *   - External links open in a new tab with `rel="noopener noreferrer"`.
 *
 * The output is NOT safe to insert on its own: raw HTML in a chapter passes
 * through untouched. `AboutChapters.js` sanitizes it before it reaches the page.
 */

/** `.about-card` styles `h3` and `h4`; chapter files use `#` and `##`. */
const HEADING_OFFSET = 2;

const EXTERNAL_URL = /^https?:\/\//i;

const FEATURE_GRID_BLOCK = /^:::[ \t]*feature-grid[ \t]*\n((?:[^\n]*\n)*?):::[ \t]*(?:\n|$)/;

/** @param {string} value */
function escapeAttribute(value) {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The bullets of a feature-grid body, one string per feature. A wrapped bullet
 * continues on an indented line; anything else makes the block malformed.
 *
 * @param {string} body
 * @returns {string[] | null}
 */
function parseFeatureItems(body) {
    /** @type {string[]} */
    const items = [];
    for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        const bullet = /^[-*+][ \t]+(.*)$/.exec(line);
        if (bullet) {
            items.push(bullet[1].trim());
        } else if (items.length && /^[ \t]+\S/.test(line)) {
            items[items.length - 1] += ` ${line.trim()}`;
        } else {
            return null;
        }
    }
    return items;
}

/** `::: feature-grid` … `:::` containing a bullet list. */
const featureGrid = {
    name: 'featureGrid',
    level: /** @type {'block'} */ ('block'),
    start(/** @type {string} */ src) {
        const index = src.search(/^:::[ \t]*feature-grid/m);
        return index < 0 ? undefined : index;
    },
    tokenizer(/** @type {string} */ src) {
        const match = FEATURE_GRID_BLOCK.exec(src);
        if (!match) return undefined;
        const items = parseFeatureItems(match[1]);
        // A malformed block is left as the plain text it was written as, where
        // whoever edits the chapter will see it.
        if (!items) return undefined;
        return {
            type: 'featureGrid',
            raw: match[0],
            items: items.map((text) => ({ text, tokens: this.lexer.inlineTokens(text) }))
        };
    },
    renderer(/** @type {any} */ token) {
        const features = token.items
            .map((item) => `<div class="feature">${this.parser.parseInline(item.tokens)}</div>`)
            .join('\n');
        return `<div class="feature-grid">\n${features}\n</div>\n`;
    }
};

const markdown = new Marked({
    async: false,
    gfm: true,
    breaks: false,
    extensions: [featureGrid],
    renderer: {
        heading({ tokens, depth }) {
            const level = Math.min(depth + HEADING_OFFSET, 6);
            return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
        },
        link({ href, title, tokens }) {
            const text = this.parser.parseInline(tokens);
            let target;
            try {
                target = encodeURI(href).replace(/%25/g, '%');
            } catch (_) {
                return text;
            }
            const attributes = [`href="${escapeAttribute(target)}"`];
            if (title) attributes.push(`title="${escapeAttribute(title)}"`);
            if (EXTERNAL_URL.test(target)) attributes.push('target="_blank"', 'rel="noopener noreferrer"');
            return `<a ${attributes.join(' ')}>${text}</a>`;
        }
    }
});

/**
 * Render one chapter's Markdown to (unsanitized) HTML.
 *
 * @param {string} source
 * @returns {string}
 */
export function renderChapterMarkdown(source) {
    return /** @type {string} */ (markdown.parse(`${source}`));
}
