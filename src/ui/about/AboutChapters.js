// @ts-check
import { renderChapterMarkdown } from './aboutMarkdown.js';

/**
 * Deep dive chapters on the About page.
 *
 * index.html owns the frame: six stable `<article class="about-card lp-reveal">`
 * elements inside `.lp-showcase-cards`, each with its anchor id and a
 * `data-about-src` pointing at the Markdown file that is the chapter's only
 * copy (content/about/*.md). This module fetches those files, renders and
 * sanitizes them, and puts the result straight into the article — as its direct
 * children, because `.about-card > h3 / > p / > .feature-grid` is what styles it.
 *
 * Each chapter loads on its own: one that fails shows a message with a link to
 * its source and a retry button, and leaves the other five alone.
 */

/** Fired on the document each time a chapter's content has been rendered. */
export const ABOUT_CHAPTERS_RENDERED_EVENT = 'web25:about-chapters-rendered';

const CHAPTER_SELECTOR = '.lp-showcase-cards > article[data-about-src]';
const PURIFY_SRC = 'scripts/purify.min.js';
const FETCH_TIMEOUT_MS = 10000;

/**
 * Per-call sanitizer settings. DOMPurify is shared with the site renderer, so
 * nothing here may touch its global config or hooks.
 *
 * Chapters are plain prose, links and feature grids: HTML only (no SVG/MathML),
 * no forms, and no inline styles — presentation stays in styles.css. `target`
 * is allowed because external links open in a new tab; `hardenLinks` below
 * pairs every one of them with `rel`.
 */
const SANITIZE_CONFIG = Object.freeze({
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style'],
    RETURN_DOM_FRAGMENT: true
});

/**
 * @param {ParentNode} fragment
 */
function hardenLinks(fragment) {
    for (const link of fragment.querySelectorAll('a')) {
        if (link.getAttribute('target') === '_blank') {
            link.setAttribute('rel', 'noopener noreferrer');
        } else {
            link.removeAttribute('target');
        }
    }
}

/**
 * @param {{ sanitize: (html: string, config: object) => DocumentFragment }} purify
 * @returns {(html: string) => DocumentFragment}
 */
export function createChapterSanitizer(purify) {
    return (html) => {
        const fragment = purify.sanitize(html, { ...SANITIZE_CONFIG });
        hardenLinks(fragment);
        return fragment;
    };
}

/**
 * DOMPurify ships with the app (scripts/purify.min.js) and is normally loaded
 * by the application bootstrap, but the About page must not wait for it. The
 * script tag uses the absolute URL on purpose: the bootstrap's own loader
 * treats a `script[src="scripts/purify.min.js"]` it finds as "already loaded"
 * and moves on, which would race a tag that is still downloading.
 *
 * @param {Document} doc
 * @returns {Promise<(html: string) => DocumentFragment>}
 */
async function loadDefaultSanitizer(doc) {
    if (!globalThis.DOMPurify) {
        const src = new URL(PURIFY_SRC, doc.baseURI).href;
        await new Promise((resolve, reject) => {
            const script = doc.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve(undefined);
            script.onerror = () => reject(new Error(`Failed to load ${PURIFY_SRC}`));
            doc.head.appendChild(script);
        });
    }
    // Without a sanitizer the chapter is not rendered at all.
    if (!globalThis.DOMPurify) throw new Error('DOMPurify is unavailable');
    return createChapterSanitizer(globalThis.DOMPurify);
}

/**
 * @param {string} src
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string>}
 */
async function fetchChapterSource(src, fetchImpl) {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
    const response = await fetchImpl(src, { signal });
    if (!response.ok) throw new Error(`${src} responded ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error(`${src} is empty`);
    // A static host that answers a missing file with its index page returns 200.
    if (/^\s*<(?:!doctype|html)\b/i.test(text)) throw new Error(`${src} is not Markdown`);
    return text;
}

/**
 * The chapter's name as the index shows it, for the failure message.
 *
 * @param {Element} article
 */
function chapterLabel(article) {
    const link = article.ownerDocument.querySelector(`.lp-showcase-index a[href="#${article.id}"]`);
    return link?.textContent?.trim() || 'Chapter';
}

/**
 * @param {HTMLElement} article
 * @param {string} src
 */
function showChapterError(article, src) {
    const doc = article.ownerDocument;

    const title = doc.createElement('h3');
    title.textContent = chapterLabel(article);

    const message = doc.createElement('p');
    message.className = 'about-card-status';
    message.setAttribute('role', 'alert');
    message.append('This chapter could not be loaded. ');
    const source = doc.createElement('a');
    source.href = src;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = 'Read the Markdown source';
    message.append(source, '.');

    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-secondary about-card-retry';
    retry.dataset.aboutRetry = '';
    retry.textContent = 'Try again';

    article.replaceChildren(title, message, retry);
    article.dataset.aboutState = 'error';
    article.removeAttribute('aria-busy');
}

/**
 * Load every chapter listed in the page and render it in place.
 *
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(doc: Document) => Promise<(html: string) => DocumentFragment>} [options.loadSanitizer]
 * @returns {Promise<PromiseSettledResult<void>[]>} settles once every chapter has rendered or failed
 */
export function installAboutChapters({
    doc = document,
    fetchImpl = (...args) => fetch(...args),
    loadSanitizer = loadDefaultSanitizer
} = {}) {
    const articles = /** @type {HTMLElement[]} */ (Array.from(doc.querySelectorAll(CHAPTER_SELECTOR)));

    /** @type {Promise<(html: string) => DocumentFragment> | null} */
    let sanitizerPromise = null;
    const getSanitizer = () => {
        if (!sanitizerPromise) {
            sanitizerPromise = loadSanitizer(doc);
            // A failed load is attempted again by the next retry.
            sanitizerPromise.catch(() => {
                sanitizerPromise = null;
            });
        }
        return sanitizerPromise;
    };

    /** @param {HTMLElement} article */
    const loadChapter = async (article) => {
        const src = article.dataset.aboutSrc || '';
        article.dataset.aboutState = 'loading';
        article.setAttribute('aria-busy', 'true');
        try {
            const [markdown, sanitize] = await Promise.all([fetchChapterSource(src, fetchImpl), getSanitizer()]);
            article.replaceChildren(sanitize(renderChapterMarkdown(markdown)));
            article.dataset.aboutState = 'ready';
            article.removeAttribute('aria-busy');
            doc.dispatchEvent(new CustomEvent(ABOUT_CHAPTERS_RENDERED_EVENT, { detail: { id: article.id } }));
        } catch (error) {
            console.warn(`[About] Could not load ${src}:`, error);
            showChapterError(article, src);
        }
    };

    for (const article of articles) {
        article.addEventListener('click', (event) => {
            // Duck-typed: a click target is always an element.
            const target = /** @type {Element | null} */ (event.target);
            if (target?.closest?.('[data-about-retry]')) void loadChapter(article);
        });
    }

    return Promise.allSettled(articles.map(loadChapter));
}

/**
 * Run `callback` now and again after each chapter render. For code that adds
 * to a chapter at runtime: a retried chapter is rebuilt from its Markdown, so
 * whatever was added to it has to be added again.
 *
 * @param {() => void} callback
 * @param {Document} [doc]
 */
export function onAboutChaptersRendered(callback, doc = document) {
    doc.addEventListener(ABOUT_CHAPTERS_RENDERED_EVENT, () => callback());
    callback();
}
