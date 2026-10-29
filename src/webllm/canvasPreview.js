// @ts-check
/**
 * The document the canvas previews.
 *
 * A project is a handful of text files — an HTML page that links a stylesheet
 * and a script by relative path. The preview frame is sandboxed into an opaque
 * origin and has no file system to resolve those paths against, so the page
 * is put together here: every `<link rel="stylesheet">` and `<script src>`
 * that names a project file is replaced by that file, inline. A lone CSS or JS
 * snippet gets a small page of its own to run in.
 *
 * A console bridge goes first in the page: `console.*` calls and uncaught
 * errors are posted to the canvas, which lists them under the preview.
 *
 * The frame this is shown in has `sandbox="allow-scripts allow-modals"` and
 * never `allow-same-origin`: whatever the code does, it does it outside this
 * app's origin, its storage and its wallet.
 */

import { parentOf } from './projectTree.js';

export const CANVAS_MESSAGE_SOURCE = 'web25-canvas';

/** Posts console output and errors to the canvas. Runs first in the preview. */
const CONSOLE_BRIDGE = `<script>(function () {
  var post = function (level, args) {
    try {
      var text = Array.prototype.map.call(args, function (value) {
        if (value instanceof Error) return value.name + ': ' + value.message;
        if (typeof value === 'object') { try { return JSON.stringify(value); } catch (e) { return String(value); } }
        return String(value);
      }).join(' ');
      parent.postMessage({ source: '${CANVAS_MESSAGE_SOURCE}', level: level, text: text.slice(0, 2000) }, '*');
    } catch (e) {}
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    console[level] = function () { post(level, arguments); if (original) original.apply(console, arguments); };
  });
  addEventListener('error', function (event) { post('error', [event.message + (event.lineno ? ' (line ' + event.lineno + ')' : '')]); });
  addEventListener('unhandledrejection', function (event) { post('error', ['Unhandled rejection: ' + (event.reason && event.reason.message || event.reason)]); });
})();</script>`;

/** Keep inlined code from closing the element that holds it. @param {string} code @param {string} tag */
const seal = (code, tag) => code.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);

/** @param {string} tag @param {string} name */
function attribute(tag, name) {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

/**
 * A reference from `fromDir` to a project path, or null when it points
 * outside the project (an absolute URL, a CDN, `..` past the top).
 * @param {string} fromDir
 * @param {string} href
 */
export function resolveProjectPath(fromDir, href) {
    const value = `${href || ''}`.trim().split(/[?#]/)[0];
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
    const segments = value.startsWith('/') ? [] : fromDir ? fromDir.split('/') : [];
    for (const segment of value.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (segments.length === 0) return null;
            segments.pop();
        } else segments.push(segment);
    }
    return segments.join('/') || null;
}

/**
 * Inline the project's stylesheets and scripts into one HTML page.
 * @param {string} html
 * @param {string} htmlPath
 * @param {Map<string, string>} files
 */
export function inlineProjectAssets(html, htmlPath, files) {
    const dir = parentOf(htmlPath);
    const withStyles = html.replace(/<link\b[^>]*>/gi, (tag) => {
        if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
        const path = resolveProjectPath(dir, attribute(tag, 'href') || '');
        if (!path || !files.has(path)) return tag;
        return `<style data-file="${path}">\n${seal(/** @type {string} */ (files.get(path)), 'style')}\n</style>`;
    });
    return withStyles.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs) => {
        const src = attribute(`<script ${attrs}>`, 'src');
        const path = src === null ? null : resolveProjectPath(dir, src);
        if (!path || !files.has(path)) return tag;
        const type = attribute(`<script ${attrs}>`, 'type');
        const typed = type ? ` type="${type.replace(/"/g, '')}"` : '';
        return `<script data-file="${path}"${typed}>\n${seal(/** @type {string} */ (files.get(path)), 'script')}\n</script>`;
    });
}

/** Put the console bridge first in a page, whatever shape the page has. @param {string} html */
function withBridge(html) {
    if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}\n${CONSOLE_BRIDGE}`);
    if (/<html\b[^>]*>/i.test(html)) {
        return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}\n<head>${CONSOLE_BRIDGE}</head>`);
    }
    return `${CONSOLE_BRIDGE}\n${html}`;
}

/** @param {string} path */
const extensionOf = (path) => `${path}`.split('.').pop()?.toLowerCase() || '';

const STANDALONE_BODY =
    '<main style="font:16px/1.5 system-ui,sans-serif;padding:1.5rem;max-width:40rem">' +
    '<h1>Heading</h1><p>A paragraph with <a href="#">a link</a> and <button>a button</button>.</p>' +
    '<ul><li>First item</li><li>Second item</li></ul></main>';

/**
 * The page to show for the canvas's current file.
 *
 * An HTML file is shown as itself; a stylesheet or script that a project page
 * links is shown through that page; anything else gets a page of its own.
 *
 * @param {{ path: string, code: string, files?: Map<string, string> }} current
 *   `files` is the project, text by path; `code` wins over the stored copy of
 *   `path`, so unsaved edits are what is previewed
 * @returns {{ html: string, entry: string|null }}
 */
export function buildPreviewDocument({ path, code, files = new Map() }) {
    const project = new Map(files);
    if (path) project.set(path, code);
    const ext = extensionOf(path);

    /** @type {string|null} */
    let entry = null;
    if (ext === 'html' || ext === 'htm') entry = path;
    else if (ext === 'css' || ext === 'js' || ext === 'mjs') {
        // The page that links this file, else the project's index.html.
        const pages = [...project.keys()].filter((key) => /\.html?$/i.test(key));
        entry =
            pages.find((page) => {
                const html = /** @type {string} */ (project.get(page));
                const pattern = /\b(?:href|src)\s*=\s*["']?([^"'\s>]+)/gi;
                for (const match of html.matchAll(pattern)) {
                    if (resolveProjectPath(parentOf(page), match[1]) === path) return true;
                }
                return false;
            }) ||
            pages.find((page) => page === 'index.html') ||
            null;
    }

    if (entry) {
        return {
            html: withBridge(inlineProjectAssets(/** @type {string} */ (project.get(entry)), entry, project)),
            entry
        };
    }

    let html;
    if (ext === 'css') {
        html = `<!doctype html><html><head><style>\n${seal(code, 'style')}\n</style></head><body>${STANDALONE_BODY}</body></html>`;
    } else if (ext === 'js' || ext === 'mjs') {
        const type = ext === 'mjs' ? ' type="module"' : '';
        html = `<!doctype html><html><head></head><body><div id="app"></div><script${type}>\n${seal(code, 'script')}\n</script></body></html>`;
    } else if (ext === 'svg') {
        html = `<!doctype html><html><head></head><body style="margin:0;display:grid;place-items:center;min-height:100vh">${code}</body></html>`;
    } else {
        const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        html = `<!doctype html><html><head></head><body><pre style="font:13px/1.5 ui-monospace,monospace;padding:1rem;white-space:pre-wrap">${escaped}</pre></body></html>`;
    }
    return { html: withBridge(html), entry: null };
}
