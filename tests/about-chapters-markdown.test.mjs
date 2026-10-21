/**
 * The About page's Deep dive chapters live in content/about/*.md.
 *
 * What is checked here, with no browser:
 *   - the six files render, through the real renderer, to exactly the markup
 *     they replaced (tests/fixtures/about-chapters.legacy.html) — nothing
 *     rewritten, shortened or dropped, feature grids included;
 *   - index.html is only the frame: six stable article shells, no chapter copy;
 *   - the Markdown flavour the chapters rely on (heading offset, feature grids,
 *     link policy) behaves as documented;
 *   - the loader degrades one chapter at a time and never inserts HTML that did
 *     not go through the sanitizer.
 *
 * The same page is exercised in a real browser by about-page-browser.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { renderChapterMarkdown } from '../src/ui/about/aboutMarkdown.js';
import {
    ABOUT_CHAPTERS_RENDERED_EVENT,
    createChapterSanitizer,
    installAboutChapters
} from '../src/ui/about/AboutChapters.js';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const INDEX_HTML = read('index.html');
const LEGACY = read('tests/fixtures/about-chapters.legacy.html');

const CHAPTERS = [
    { slug: 'identity', label: 'Identity', title: '🪪 Identity: one local key, three addresses', features: 7 },
    { slug: 'publishing', label: 'Publishing', title: '📦 Publishing: Bundle pipeline + .torrentchain', features: 4 },
    {
        slug: 'messenger',
        label: 'Direct Messenger',
        title: '💬 Direct Messenger: search an address, start a chat',
        features: 7
    },
    { slug: 'consent', label: 'Consent', title: '🤝 Cryptographic validity is not consent', features: 7 },
    { slug: 'nostr', label: 'Nostr relay', title: '🛰️ Nostr relay: browser to relay, directly', features: 4 },
    { slug: 'security', label: 'Security profile', title: '🛡️ Security profile', features: 4 }
];

/** Collapse source formatting so the comparison sees content and structure only. */
function normalize(html) {
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .replace(/\s*(<\/?(?:article|div|h[1-6]|p)\b[^>]*>)\s*/g, '$1')
        .replace(/\s+>/g, '>')
        .trim();
}

const legacyArticles = LEGACY.match(/<article\b[\s\S]*?<\/article>/g);

// ── the Markdown files are the chapters ─────────────────────────────────────

test('content/about holds the six chapter files and nothing else is expected there', () => {
    assert.equal(legacyArticles.length, 6, 'fixture holds the six original chapters');
    for (const { slug } of CHAPTERS) {
        assert.ok(existsSync(new URL(`../content/about/${slug}.md`, import.meta.url)), `${slug}.md exists`);
    }
});

for (const [index, chapter] of CHAPTERS.entries()) {
    test(`${chapter.slug}.md renders to exactly the markup of the chapter it replaced`, () => {
        const rendered = `<article class="about-card lp-reveal">${renderChapterMarkdown(read(`content/about/${chapter.slug}.md`))}</article>`;
        assert.equal(normalize(rendered), normalize(legacyArticles[index]));
    });

    test(`${chapter.slug}.md keeps its title, emoji and ${chapter.features} feature items`, () => {
        const html = renderChapterMarkdown(read(`content/about/${chapter.slug}.md`));
        assert.ok(html.startsWith(`<h3>${chapter.title}</h3>`), 'title is the first element, as an <h3>');
        assert.equal(html.match(/<div class="feature-grid">/g)?.length, 1);
        assert.equal(html.match(/<div class="feature">/g)?.length, chapter.features);
    });
}

test('inline formatting and links survive the move', () => {
    const identity = renderChapterMarkdown(read('content/about/identity.md'));
    assert.match(
        identity,
        /<a href="https:\/\/github\.com\/mylofi\/local-data-lock" target="_blank" rel="noopener noreferrer">mylofi\/local-data-lock<\/a>/
    );
    assert.match(identity, /<em>with<\/em>/);
    assert.match(identity, /<strong>PRF<\/strong>/);
    assert.match(identity, /<code>0x…<\/code>/);
    assert.match(identity, /<code>npub1…<\/code>/);

    const messenger = renderChapterMarkdown(read('content/about/messenger.md'));
    assert.match(messenger, /href="https:\/\/github\.com\/michal-wrzosek\/p2p-chat" target="_blank"/);
    assert.match(messenger, /<code>stun:stun\.l\.google\.com:19302<\/code>/);
    assert.match(messenger, /<strong>Connected · WebRTC<\/strong> or <strong>Connected · Nostr<\/strong>/);

    assert.match(renderChapterMarkdown(read('content/about/consent.md')), /<strong>waits<\/strong>/);
    assert.match(renderChapterMarkdown(read('content/about/nostr.md')), /<code>wss:\/\/nos\.lol<\/code>/);
});

// ── index.html is only the frame ────────────────────────────────────────────

const CARDS = INDEX_HTML.slice(
    INDEX_HTML.indexOf('<div class="lp-showcase-cards">'),
    INDEX_HTML.indexOf('<!-- Status -->')
);

test('index.html keeps six stable chapter articles inside .lp-showcase-cards', () => {
    const articles = CARDS.match(/<article\b[^>]*>/g);
    assert.equal(articles.length, 6);
    for (const [index, { slug }] of CHAPTERS.entries()) {
        assert.match(articles[index], /^<article class="about-card lp-reveal"/);
        assert.match(articles[index], new RegExp(`id="about-${slug}"`));
        assert.match(articles[index], new RegExp(`data-about-src="content/about/${slug}\\.md"`));
    }
});

test('index.html no longer carries any chapter copy', () => {
    assert.doesNotMatch(CARDS, /feature-grid|class="feature"/);
    for (const { title } of CHAPTERS) assert.ok(!INDEX_HTML.includes(title), `"${title}" is not hardcoded`);
    for (const phrase of ['non-extractable AES-GCM key', 'gift-wrapped (NIP-44 / NIP-59)', 'wss://nos.lol']) {
        assert.ok(!INDEX_HTML.includes(phrase), `"${phrase}" lives only in content/about`);
    }
});

test('the chapters are rendered locally: a bundled renderer and sanitizer, no CDN', () => {
    assert.ok(existsSync(new URL('../scripts/marked.esm.js', import.meta.url)));
    assert.ok(existsSync(new URL('../scripts/purify.min.js', import.meta.url)));
    for (const file of ['src/ui/about/aboutMarkdown.js', 'src/ui/about/AboutChapters.js']) {
        assert.doesNotMatch(read(file), /https?:\/\/(?!github\.com)/, `${file} references no remote host`);
    }
    assert.match(read('src/ui/about/aboutMarkdown.js'), /from '\.\.\/\.\.\/\.\.\/scripts\/marked\.esm\.js'/);
    assert.doesNotMatch(INDEX_HTML, /marked/i);
});

test('the app starts the chapter loader, and the Publishing note follows each render', () => {
    assert.match(read('src/main.js'), /import \{ installAboutChapters \} from '\.\/ui\/about\/AboutChapters\.js'/);
    assert.match(read('src/main.js'), /installAboutChapters\(\);/);
    assert.match(read('src/ui/publish/PublishPanel.js'), /onAboutChaptersRendered\(addPublishingMirrorNote\)/);
});

test('the published package ships the chapters and the bundled libraries', () => {
    const { files } = JSON.parse(read('package.json'));
    assert.ok(files.includes('content'));
    assert.ok(files.includes('scripts'));
});

// ── the Markdown flavour ────────────────────────────────────────────────────

test('headings are offset so a chapter file starts at #', () => {
    assert.equal(renderChapterMarkdown('# Title').trim(), '<h3>Title</h3>');
    assert.equal(renderChapterMarkdown('## Sub').trim(), '<h4>Sub</h4>');
    assert.equal(renderChapterMarkdown('###### Deep').trim(), '<h6>Deep</h6>');
});

test('a feature-grid block becomes .feature-grid with one .feature per bullet', () => {
    const html = renderChapterMarkdown('::: feature-grid\n- one `a`\n- **two**\n  wrapped\n:::\n');
    assert.equal(
        normalize(html),
        '<div class="feature-grid"><div class="feature">one <code>a</code></div><div class="feature"><strong>two</strong> wrapped</div></div>'
    );
});

test('a feature-grid interrupts a paragraph and ends before the text after it', () => {
    const html = renderChapterMarkdown('Before\n::: feature-grid\n- item\n:::\nAfter\n');
    assert.equal(
        normalize(html),
        '<p>Before</p><div class="feature-grid"><div class="feature">item</div></div><p>After</p>'
    );
});

test('a malformed feature-grid stays visible as the text it was written as', () => {
    const html = renderChapterMarkdown('::: feature-grid\nnot a bullet\n:::\n');
    assert.doesNotMatch(html, /feature-grid"/);
    assert.match(html, /not a bullet/);
});

test('external links open in a new tab safely; local and fragment links do not', () => {
    const html = renderChapterMarkdown(
        '[a](https://example.com/x?y=1&z=2) [b](#about-nostr) [c](content/about/x.md) [d](mailto:a@b.c)'
    );
    assert.match(
        html,
        /<a href="https:\/\/example\.com\/x\?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">a<\/a>/
    );
    assert.match(html, /<a href="#about-nostr">b<\/a>/);
    assert.match(html, /<a href="content\/about\/x\.md">c<\/a>/);
    assert.match(html, /<a href="mailto:a@b\.c">d<\/a>/);
});

test('a link title cannot break out of its attribute', () => {
    const html = renderChapterMarkdown('[a](https://example.com "x\\" onmouseover=\\"alert(1)")');
    const tag = /<a ([^>]*)>/.exec(html)[1];
    // The quote stays inside `title` as text; it never starts an attribute.
    const names = [...tag.matchAll(/([\w-]+)="[^"]*"/g)].map((match) => match[1]);
    assert.deepEqual(names, ['href', 'title', 'target', 'rel']);
    assert.match(tag, /title="x&quot; onmouseover=&quot;alert\(1\)"/);
});

// ── sanitizer wiring ────────────────────────────────────────────────────────

test('the sanitizer is configured per call, as HTML only, and pairs target with rel', () => {
    let seen;
    const link = (target) => {
        const attributes = new Map(target ? [['target', target]] : []);
        return {
            getAttribute: (name) => attributes.get(name) ?? null,
            setAttribute: (name, value) => attributes.set(name, value),
            removeAttribute: (name) => attributes.delete(name),
            attributes
        };
    };
    const blank = link('_blank');
    const top = link('_top');
    const plain = link(null);
    const fragment = { querySelectorAll: (selector) => (selector === 'a' ? [blank, top, plain] : []) };
    const purify = {
        sanitize(html, config) {
            seen = { html, config };
            return fragment;
        }
    };

    assert.equal(createChapterSanitizer(purify)('<p>x</p>'), fragment);
    assert.equal(seen.html, '<p>x</p>');
    assert.deepEqual(seen.config.USE_PROFILES, { html: true });
    assert.equal(seen.config.RETURN_DOM_FRAGMENT, true);
    assert.deepEqual(seen.config.ADD_ATTR, ['target']);
    assert.ok(seen.config.FORBID_ATTR.includes('style'));
    assert.ok(seen.config.FORBID_TAGS.includes('form'));

    assert.equal(blank.attributes.get('rel'), 'noopener noreferrer');
    assert.equal(top.attributes.has('target'), false, 'only _blank survives');
    assert.equal(plain.attributes.size, 0);
});

// ── loading and failure handling ────────────────────────────────────────────

/** Just enough of a document for the loader: articles, a title lookup, events. */
function fakeDocument() {
    const events = [];
    const doc = {
        events,
        createElement: (tagName) => {
            const el = {
                tagName,
                children: [],
                dataset: {},
                attributes: new Map(),
                append(...nodes) {
                    el.children.push(...nodes);
                },
                setAttribute: (name, value) => el.attributes.set(name, value)
            };
            return el;
        },
        querySelector: (selector) => {
            const id = /href="#([^"]+)"/.exec(selector)?.[1];
            const chapter = CHAPTERS.find((c) => `about-${c.slug}` === id);
            return chapter ? { textContent: ` ${chapter.label} ` } : null;
        },
        querySelectorAll: () => doc.articles,
        dispatchEvent: (event) => events.push({ type: event.type, id: event.detail?.id }),
        articles: []
    };
    doc.articles = CHAPTERS.map(({ slug }) => {
        const listeners = [];
        const article = {
            id: `about-${slug}`,
            ownerDocument: doc,
            dataset: { aboutSrc: `content/about/${slug}.md` },
            attributes: new Map([['aria-busy', 'true']]),
            content: null,
            listeners,
            setAttribute: (name, value) => article.attributes.set(name, value),
            removeAttribute: (name) => article.attributes.delete(name),
            addEventListener: (type, listener) => listeners.push({ type, listener }),
            replaceChildren: (...nodes) => {
                article.content = nodes;
            }
        };
        return article;
    });
    return doc;
}

const respond = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const sources =
    (overrides = {}) =>
    async (url) => {
        const slug = /about\/(\w+)\.md/.exec(url)[1];
        const override = overrides[slug];
        if (override instanceof Error) throw override;
        return override ?? respond(read(`content/about/${slug}.md`));
    };
const passthroughSanitizer = async () => (html) => ({ sanitizedHtml: html });

test('every chapter is fetched, rendered, sanitized and announced', async () => {
    const doc = fakeDocument();
    const requested = [];
    const fetchImpl = async (url, options) => {
        requested.push(url);
        assert.ok(options.signal === undefined || options.signal instanceof AbortSignal);
        return sources()(url);
    };

    const results = await installAboutChapters({ doc, fetchImpl, loadSanitizer: passthroughSanitizer });

    assert.deepEqual(requested.sort(), CHAPTERS.map((c) => `content/about/${c.slug}.md`).sort());
    assert.ok(results.every((r) => r.status === 'fulfilled'));
    for (const [index, article] of doc.articles.entries()) {
        assert.equal(article.dataset.aboutState, 'ready');
        assert.equal(article.attributes.has('aria-busy'), false);
        assert.equal(article.content.length, 1);
        assert.ok(article.content[0].sanitizedHtml.startsWith(`<h3>${CHAPTERS[index].title}</h3>`));
    }
    assert.deepEqual(
        doc.events.map((e) => e.type),
        Array(6).fill(ABOUT_CHAPTERS_RENDERED_EVENT)
    );
});

test('a chapter that fails to load shows its name, its source and a retry — and no other chapter notices', async () => {
    const doc = fakeDocument();
    const warn = console.warn;
    console.warn = () => {};
    try {
        await installAboutChapters({
            doc,
            fetchImpl: sources({ consent: respond('Not Found', 404), nostr: new TypeError('network down') }),
            loadSanitizer: passthroughSanitizer
        });
    } finally {
        console.warn = warn;
    }

    for (const slug of ['consent', 'nostr']) {
        const article = doc.articles.find((a) => a.id === `about-${slug}`);
        assert.equal(article.dataset.aboutState, 'error');
        assert.equal(article.attributes.has('aria-busy'), false);
        const [title, message, retry] = article.content;
        assert.equal(title.tagName, 'h3');
        assert.equal(title.textContent, CHAPTERS.find((c) => c.slug === slug).label);
        assert.equal(message.attributes.get('role'), 'alert');
        assert.equal(message.children.at(-2).href, `content/about/${slug}.md`);
        assert.equal(retry.tagName, 'button');
        assert.equal(retry.type, 'button');
        assert.equal(retry.dataset.aboutRetry, '');
    }
    const ready = doc.articles.filter((a) => a.dataset.aboutState === 'ready');
    assert.equal(ready.length, 4);
    assert.equal(doc.events.length, 4);
});

test('an empty file and an HTML page served for a missing file are failures, not content', async () => {
    const doc = fakeDocument();
    const warn = console.warn;
    console.warn = () => {};
    try {
        await installAboutChapters({
            doc,
            fetchImpl: sources({
                identity: respond('  \n '),
                publishing: respond('<!DOCTYPE html><html><body>index</body></html>')
            }),
            loadSanitizer: passthroughSanitizer
        });
    } finally {
        console.warn = warn;
    }
    assert.equal(doc.articles[0].dataset.aboutState, 'error');
    assert.equal(doc.articles[1].dataset.aboutState, 'error');
    assert.equal(doc.articles[2].dataset.aboutState, 'ready');
});

test('without a sanitizer nothing is rendered: every chapter fails closed', async () => {
    const doc = fakeDocument();
    const warn = console.warn;
    console.warn = () => {};
    try {
        await installAboutChapters({
            doc,
            fetchImpl: sources(),
            loadSanitizer: async () => {
                throw new Error('DOMPurify is unavailable');
            }
        });
    } finally {
        console.warn = warn;
    }
    assert.ok(doc.articles.every((a) => a.dataset.aboutState === 'error'));
    assert.ok(doc.articles.every((a) => a.content.every((node) => !('sanitizedHtml' in node))));
    assert.equal(doc.events.length, 0);
});

test('Try again reloads just that chapter', async () => {
    const doc = fakeDocument();
    const warn = console.warn;
    console.warn = () => {};
    let healthy = false;
    let identityFetches = 0;
    const fetchImpl = async (url) => {
        if (url.endsWith('identity.md')) {
            identityFetches += 1;
            if (!healthy) return respond('', 503);
        }
        return sources()(url);
    };
    try {
        await installAboutChapters({ doc, fetchImpl, loadSanitizer: passthroughSanitizer });
        const article = doc.articles[0];
        assert.equal(article.dataset.aboutState, 'error');

        healthy = true;
        const [{ listener }] = article.listeners.filter((l) => l.type === 'click');
        const clickOn = (matches) => ({ target: { closest: (selector) => (matches(selector) ? {} : null) } });
        // A click anywhere else in the card does nothing…
        listener(clickOn(() => false));
        assert.equal(identityFetches, 1);
        // …a click on the retry button reloads.
        listener(clickOn((selector) => selector === '[data-about-retry]'));
        await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
        console.warn = warn;
    }
    assert.equal(identityFetches, 2);
    assert.equal(doc.articles[0].dataset.aboutState, 'ready');
});
