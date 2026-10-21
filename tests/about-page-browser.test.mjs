/**
 * The About page, in a real browser.
 *
 * about-chapters-markdown.test.mjs and about-page-markup.test.mjs pin the
 * Markdown, the renderer and the stylesheet contracts. What only a browser can
 * show is checked here: that the six chapter files load and sanitize into the
 * page, that the page lays out exactly as it did when the chapters were
 * hardcoded, and that the chapter index navigates, scrolls and focuses the way
 * it should.
 *
 * Needs Playwright with a Chromium build (`PLAYWRIGHT_BROWSERS_PATH` or the
 * default Playwright cache). Without them every test here is skipped, with the
 * reason in the report. The full application is not started — it pulls its
 * dependencies from the network — so `/peerweb.min.js` is answered with a stub
 * that boots only the About modules; everything else is the real index.html,
 * styles.css and src/ served from this checkout.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LEGACY_HTML = readFileSync(new URL('./fixtures/about-chapters.legacy.html', import.meta.url), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

const CHAPTERS = [
    { slug: 'identity', label: 'Identity', title: '🪪 Identity: one local key, three addresses' },
    { slug: 'publishing', label: 'Publishing', title: '📦 Publishing: Bundle pipeline + .torrentchain' },
    { slug: 'messenger', label: 'Direct Messenger', title: '💬 Direct Messenger: search an address, start a chat' },
    { slug: 'consent', label: 'Consent', title: '🤝 Cryptographic validity is not consent' },
    { slug: 'nostr', label: 'Nostr relay', title: '🛰️ Nostr relay: browser to relay, directly' },
    { slug: 'security', label: 'Security profile', title: '🛡️ Security profile' }
];

const DESKTOP = { width: 1280, height: 800 };
const TABLET = { width: 900, height: 800 };
const PHONE = { width: 390, height: 844 };

/** Boots just the About modules; the rest of the app needs the network. */
const STUB_ENTRY = `
import { installAboutChapters } from '/src/ui/about/AboutChapters.js';
import { bindPublishActions } from '/src/ui/publish/PublishPanel.js';
bindPublishActions({ onSign() {}, onPublish() {} });
installAboutChapters();
`;

/** The chapters alone, without the runtime note PublishPanel adds to one of them. */
const CHAPTERS_ONLY_ENTRY = `
import { installAboutChapters } from '/src/ui/about/AboutChapters.js';
installAboutChapters();
`;

// ── Playwright, if this machine has it ──────────────────────────────────────

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch (_) {
        // Not a dependency of this repo: fall back to a global install.
    }
    try {
        const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
        return createRequire(path.join(globalRoot, '/'))('playwright');
    } catch (_) {
        return null;
    }
}

const playwright = await loadPlaywright();
const chromium = playwright?.chromium ?? playwright?.default?.chromium;
let browser = null;
try {
    browser = chromium ? await chromium.launch() : null;
} catch (_) {
    browser = null;
}
const SKIP = browser ? false : 'Playwright with a Chromium build is not available on this machine';

// ── a static server for this checkout ───────────────────────────────────────

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const file = path.join(ROOT, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
    if (!file.startsWith(ROOT)) {
        response.writeHead(403).end();
        return;
    }
    try {
        const body = await readFile(file);
        response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        response.end(body);
    } catch (_) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

after(async () => {
    await browser?.close();
    server.close();
});

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Open the About tab at a given size. `route(route, url)` may answer a request
 * and return true; everything not served from this checkout is refused, so the
 * page never depends on the network.
 */
async function openAbout({ viewport = DESKTOP, reducedMotion = 'no-preference', entry = STUB_ENTRY, route } = {}) {
    const context = await browser.newContext({ viewport, reducedMotion });
    const page = await context.newPage();
    const problems = [];
    const requests = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
        if (message.type() === 'error') problems.push(`console: ${message.text()}`);
    });
    await page.route('**/*', async (pending) => {
        const url = new URL(pending.request().url());
        if (url.origin !== ORIGIN) return pending.abort();
        requests.push(url.pathname);
        if (url.pathname === '/peerweb.min.js') {
            return pending.fulfill({ contentType: 'text/javascript', body: entry });
        }
        if (route && (await route(pending, url))) return undefined;
        return pending.continue();
    });
    await page.goto(`${ORIGIN}/`);
    // On a phone the tab list is behind the burger.
    if (viewport.width <= 720) await page.click('#nav-toggle');
    await page.click('.tab-btn[data-tab="about"]');
    // The panel slides in over 0.24s; a scroll aimed at it before that ends
    // is aimed at where its content is mid-slide.
    await page.waitForFunction(() =>
        document
            .getElementById('tab-about')
            .getAnimations()
            .every((animation) => animation.playState === 'finished')
    );
    return { page, context, problems, requests };
}

const settled = (page, count = 6) =>
    page.waitForFunction(
        (n) =>
            [...document.querySelectorAll('.lp-showcase-cards > article')].filter((a) =>
                ['ready', 'error'].includes(a.dataset.aboutState)
            ).length === n,
        count
    );

const states = (page) =>
    page.$$eval('.lp-showcase-cards > article', (articles) => articles.map((a) => a.dataset.aboutState));

/** Wait for a scroll that started at `from` to begin and then come to rest. */
const scrollRest = (page, from) =>
    page.evaluate(
        (start) =>
            new Promise((resolve) => {
                let last = start;
                let still = 0;
                let frames = 0;
                const tick = () => {
                    frames += 1;
                    if (window.scrollY === last) still += 1;
                    else {
                        still = 0;
                        last = window.scrollY;
                    }
                    // Give a scroll a few frames to begin, then require it to hold still.
                    if (still >= 8 && (last !== start || frames > 30)) resolve(window.scrollY);
                    else requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }),
        from
    );

/** Put the chapter index in view without animating, so a click is stable. */
const showRail = (page) =>
    page.evaluate(() => {
        document.querySelector('.lp-showcase-rail').scrollIntoView({ behavior: 'instant', block: 'start' });
        return window.scrollY;
    });

function normalize(html) {
    return html
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .replace(/\s*(<\/?(?:article|div|h[1-6]|p)\b[^>]*>)\s*/g, '$1')
        .replace(/\s+>/g, '>')
        .trim();
}

/** Size, position and look of the Deep dive frame and everything in the cards. */
const measureLayout = (page) =>
    page.evaluate(() => {
        const round = (n) => Math.round(n * 2) / 2;
        const describe = (element, origin) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return [
                element.tagName.toLowerCase() +
                    (element.className ? `.${String(element.className).split(' ').join('.')}` : ''),
                round(box.left - origin.left),
                round(box.top - origin.top),
                round(box.width),
                round(box.height),
                style.fontSize,
                style.fontWeight,
                style.color,
                style.marginTop,
                style.marginBottom,
                style.paddingTop,
                style.paddingLeft,
                style.display,
                style.gridTemplateColumns
            ];
        };
        const grid = document.querySelector('.lp-showcase');
        const gridBox = grid.getBoundingClientRect();
        const rail = document.querySelector('.lp-showcase-rail');
        const cards = document.querySelector('.lp-showcase-cards');
        const cardsBox = cards.getBoundingClientRect();
        return {
            grid: [round(gridBox.width), getComputedStyle(grid).gridTemplateColumns],
            rail: describe(rail, gridBox),
            railPosition: `${getComputedStyle(rail).position}/${getComputedStyle(rail).top}`,
            index: [...rail.querySelectorAll('li')].map((li) => describe(li, rail.getBoundingClientRect())),
            cards: [...cards.children].map((article) => {
                const articleBox = article.getBoundingClientRect();
                return {
                    self: describe(article, cardsBox),
                    descendants: [...article.querySelectorAll('*')].map((child) => describe(child, articleBox))
                };
            }),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
        };
    });

// ── loading and rendering ───────────────────────────────────────────────────

test('all six Markdown files are fetched and rendered into the original article elements', { skip: SKIP }, async () => {
    const { page, context, problems, requests } = await openAbout();
    try {
        await settled(page);

        assert.deepEqual(
            requests.filter((p) => p.startsWith('/content/about/')).sort(),
            CHAPTERS.map((c) => `/content/about/${c.slug}.md`).sort()
        );
        assert.deepEqual(await states(page), Array(6).fill('ready'));

        const articles = await page.$$eval('.lp-showcase-cards > article', (nodes) =>
            nodes.map((a) => ({
                id: a.id,
                className: a.className,
                busy: a.hasAttribute('aria-busy'),
                firstChild: a.firstElementChild.tagName,
                title: a.firstElementChild.textContent,
                childTags: [...a.children].map((c) => c.tagName),
                grids: a.querySelectorAll(':scope > .feature-grid').length,
                features: a.querySelectorAll(':scope > .feature-grid > .feature').length,
                status: a.querySelectorAll('.about-card-status').length
            }))
        );
        assert.equal(articles.length, 6, 'exactly six cards in the grid');
        for (const [index, article] of articles.entries()) {
            assert.equal(article.id, `about-${CHAPTERS[index].slug}`);
            assert.equal(article.className, 'about-card lp-reveal');
            assert.equal(article.busy, false);
            assert.equal(article.firstChild, 'H3', 'title is a direct child, as .about-card > h3 expects');
            assert.equal(article.title, CHAPTERS[index].title);
            assert.equal(article.grids, 1);
            assert.ok(article.features >= 4);
            assert.equal(article.status, 0, 'the loading text is gone');
            assert.ok(
                article.childTags.every((tag) => ['H3', 'P', 'DIV'].includes(tag)),
                'only direct block children'
            );
        }
        assert.equal(
            articles.reduce((n, a) => n + a.features, 0),
            33
        );
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('the rendered page is the original chapter markup, element for element', { skip: SKIP }, async () => {
    const { page, context } = await openAbout({ entry: CHAPTERS_ONLY_ENTRY });
    try {
        await settled(page);
        // The sanitizer re-adds attributes in its own order, which means nothing to a page.
        const { rendered, original } = await page.evaluate((legacy) => {
            const sortAttributes = (root) => {
                for (const element of root.querySelectorAll('*')) {
                    const attributes = [...element.attributes].map((a) => [a.name, a.value]).sort();
                    for (const [name] of attributes) element.removeAttribute(name);
                    for (const [name, value] of attributes) element.setAttribute(name, value);
                }
                return root;
            };
            const template = document.createElement('template');
            template.innerHTML = legacy;
            return {
                rendered: [...document.querySelectorAll('.lp-showcase-cards > article')].map(
                    (a) => sortAttributes(a.cloneNode(true)).innerHTML
                ),
                original: [...template.content.querySelectorAll('article')].map((a) => sortAttributes(a).innerHTML)
            };
        }, LEGACY_HTML);

        assert.equal(original.length, 6);
        for (const [index, html] of rendered.entries()) {
            assert.equal(
                normalize(html),
                normalize(original[index]),
                `${CHAPTERS[index].slug} differs from the original`
            );
        }
    } finally {
        await context.close();
    }
});

for (const [name, viewport] of [
    ['desktop', DESKTOP],
    ['tablet', TABLET],
    ['phone', PHONE]
]) {
    test(`${name} layout is identical to the page with the chapters hardcoded`, { skip: SKIP }, async () => {
        // Without animation, so a reveal transform cannot skew the boxes.
        const markdown = await openAbout({ viewport, reducedMotion: 'reduce', entry: CHAPTERS_ONLY_ENTRY });
        const hardcoded = await openAbout({ viewport, reducedMotion: 'reduce', entry: '' });
        try {
            await settled(markdown.page);
            await hardcoded.page.evaluate((html) => {
                document.querySelector('.lp-showcase-cards').innerHTML = html;
            }, LEGACY_HTML);

            const actual = await measureLayout(markdown.page);
            const expected = await measureLayout(hardcoded.page);

            assert.equal(actual.cards.length, 6);
            assert.equal(
                actual.cards.reduce((n, c) => n + c.descendants.length, 0),
                expected.cards.reduce((n, c) => n + c.descendants.length, 0)
            );
            assert.deepEqual(actual, expected);
            assert.equal(actual.overflow, 0, 'no horizontal overflow');
        } finally {
            await markdown.context.close();
            await hardcoded.context.close();
        }
    });
}

test('desktop: the rail sits left of the cards and stays pinned while they scroll', { skip: SKIP }, async () => {
    const { page, context } = await openAbout();
    try {
        await settled(page);
        const frame = await page.evaluate(() => {
            const rail = document.querySelector('.lp-showcase-rail').getBoundingClientRect();
            const cards = document.querySelector('.lp-showcase-cards').getBoundingClientRect();
            return { railRight: rail.right, cardsLeft: cards.left, sameTop: Math.abs(rail.top - cards.top) < 1 };
        });
        assert.ok(frame.railRight <= frame.cardsLeft, 'rail is a column to the left of the cards');
        assert.ok(frame.sameTop);

        await page.evaluate(() => {
            const cards = document.querySelector('.lp-showcase-cards');
            window.scrollTo({ top: cards.getBoundingClientRect().top + window.scrollY + 900, behavior: 'instant' });
        });
        const pinned = await page.evaluate(() => {
            const rail = document.querySelector('.lp-showcase-rail');
            return {
                position: getComputedStyle(rail).position,
                top: rail.getBoundingClientRect().top,
                expected:
                    parseFloat(
                        getComputedStyle(document.querySelector('.lp-showcase')).getPropertyValue('--showcase-top')
                    ) * 16
            };
        });
        assert.equal(pinned.position, 'sticky');
        assert.ok(
            Math.abs(pinned.top - pinned.expected) < 1,
            `rail pinned at ${pinned.expected}px, was ${pinned.top}px`
        );
    } finally {
        await context.close();
    }
});

test('phone: the layout stacks, rail above cards, nothing overflows', { skip: SKIP }, async () => {
    const { page, context } = await openAbout({ viewport: PHONE });
    try {
        await settled(page);
        const frame = await page.evaluate(() => {
            const rail = document.querySelector('.lp-showcase-rail');
            const cards = document.querySelector('.lp-showcase-cards');
            const railBox = rail.getBoundingClientRect();
            const cardsBox = cards.getBoundingClientRect();
            return {
                position: getComputedStyle(rail).position,
                stacked: railBox.bottom <= cardsBox.top + 0.5,
                sameWidth: Math.abs(railBox.width - cardsBox.width) < 1,
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                widest: Math.max(...[...cards.querySelectorAll('*')].map((el) => el.getBoundingClientRect().right))
            };
        });
        assert.equal(frame.position, 'static');
        assert.ok(frame.stacked);
        assert.ok(frame.sameWidth);
        assert.equal(frame.overflow, 0);
        assert.ok(frame.widest <= PHONE.width, 'no card content past the viewport edge');
    } finally {
        await context.close();
    }
});

// ── anchor navigation ───────────────────────────────────────────────────────

for (const [name, viewport] of [
    ['desktop', DESKTOP],
    ['tablet', TABLET],
    ['phone', PHONE]
]) {
    test(`${name}: each index link scrolls its chapter into view below the sticky strip`, { skip: SKIP }, async () => {
        const { page, context, problems } = await openAbout({ viewport });
        try {
            await settled(page);
            const margin = await page.evaluate(() =>
                parseFloat(getComputedStyle(document.querySelector('#about-identity')).scrollMarginTop)
            );
            const strip = await page.evaluate(() => {
                const nav = document.querySelector('.tab-nav');
                return getComputedStyle(nav).display === 'none' ? 0 : nav.getBoundingClientRect().height;
            });

            for (const { slug } of CHAPTERS) {
                const from = await showRail(page);
                await page.click(`.lp-showcase-index a[href="#about-${slug}"]`);
                await scrollRest(page, from);

                assert.equal(await page.evaluate(() => location.hash), `#about-${slug}`, 'the URL follows the link');
                const top = await page.evaluate(
                    (id) => document.getElementById(id).getBoundingClientRect().top,
                    `about-${slug}`
                );
                assert.ok(Math.abs(top - margin) <= 1.5, `${slug}: card top ${top}px, expected ${margin}px`);
                // The pinned strip never covers the top of the card.
                assert.ok(top >= strip + 8, `${slug}: card top ${top}px clears the ${strip}px strip`);
            }
            // Never a navigation away from the app.
            assert.equal(await page.evaluate(() => location.pathname), '/');
            assert.deepEqual(problems, []);
        } finally {
            await context.close();
        }
    });
}

test(
    'the offset is exactly what the sticky strip needs: it clears it with room to spare, at every width that pins it',
    { skip: SKIP },
    async () => {
        for (const viewport of [DESKTOP, TABLET]) {
            const { page, context } = await openAbout({ viewport });
            try {
                await settled(page);
                await page.evaluate(() => window.scrollTo({ top: 3000, behavior: 'instant' }));
                const { navTop, navBottom, margin } = await page.evaluate(() => {
                    const nav = document.querySelector('.tab-nav').getBoundingClientRect();
                    return {
                        navTop: nav.top,
                        navBottom: nav.bottom,
                        margin: parseFloat(getComputedStyle(document.querySelector('#about-consent')).scrollMarginTop)
                    };
                });
                assert.equal(navTop, 0, 'the tab strip is pinned');
                assert.ok(navBottom + 8 <= margin, `strip ends at ${navBottom}px, cards stop at ${margin}px`);
            } finally {
                await context.close();
            }
        }
    }
);

test('with motion allowed, the page scrolls smoothly to a chapter', { skip: SKIP }, async () => {
    const { page, context } = await openAbout({ reducedMotion: 'no-preference' });
    try {
        await settled(page);
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'smooth');

        const from = await showRail(page);
        await page.evaluate(() => {
            window.__samples = [];
            const sample = () => {
                window.__samples.push(window.scrollY);
                window.__sampling = requestAnimationFrame(sample);
            };
            sample();
        });
        await page.click('.lp-showcase-index a[href="#about-security"]');
        const to = await scrollRest(page, from);
        const samples = await page.evaluate(() => {
            cancelAnimationFrame(window.__sampling);
            return window.__samples;
        });

        assert.ok(to > from + 500, 'the page moved a good way down');
        const between = new Set(samples.filter((y) => y > from + 1 && y < to - 1));
        assert.ok(between.size >= 3, `expected an animated scroll, saw ${between.size} intermediate positions`);
        assert.ok(
            samples.every((y, i) => i === 0 || y >= samples[i - 1]),
            'and it only ever moves forward'
        );
    } finally {
        await context.close();
    }
});

test('with reduced motion, the same click jumps and nothing animates', { skip: SKIP }, async () => {
    const { page, context } = await openAbout({ reducedMotion: 'reduce' });
    try {
        await settled(page);
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
        assert.equal(
            await page.evaluate(() => getComputedStyle(document.querySelector('#about-consent')).animationName),
            'none',
            'the scroll reveal is off too'
        );

        const from = await showRail(page);
        await page.evaluate(() => {
            window.__samples = [];
            const sample = () => {
                window.__samples.push(window.scrollY);
                window.__sampling = requestAnimationFrame(sample);
            };
            sample();
        });
        await page.click('.lp-showcase-index a[href="#about-security"]');
        const to = await scrollRest(page, from);
        const samples = await page.evaluate(() => {
            cancelAnimationFrame(window.__sampling);
            return window.__samples;
        });

        assert.ok(to > from + 500);
        const between = samples.filter((y) => y > from + 1 && y < to - 1);
        assert.deepEqual(between, [], 'no frame was drawn part-way');
    } finally {
        await context.close();
    }
});

test('with motion allowed, the scroll reveal still runs on the cards', { skip: SKIP }, async () => {
    const { page, context } = await openAbout({ reducedMotion: 'no-preference' });
    try {
        await settled(page);
        const reveal = await page.evaluate(() => ({
            supported: CSS.supports('animation-timeline: view()'),
            name: getComputedStyle(document.querySelector('#about-nostr')).animationName
        }));
        assert.equal(reveal.name, reveal.supported ? 'lp-reveal' : 'none');
    } finally {
        await context.close();
    }
});

test('scrolling elsewhere in the app is not made smooth by the About rule', { skip: SKIP }, async () => {
    const { page, context } = await openAbout({ reducedMotion: 'no-preference' });
    try {
        await settled(page);
        await page.click('.tab-btn[data-tab="browse"]');
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
        await page.click('.tab-btn[data-tab="about"]');
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'smooth');
    } finally {
        await context.close();
    }
});

test('the index works from the keyboard: Tab order, visible focus, Enter navigates', { skip: SKIP }, async () => {
    const { page, context } = await openAbout();
    try {
        await settled(page);
        await showRail(page);

        const active = () =>
            page.evaluate(() => {
                const el = document.activeElement;
                const style = getComputedStyle(el);
                return {
                    href: el.getAttribute('href'),
                    outlineStyle: style.outlineStyle,
                    outlineWidth: parseFloat(style.outlineWidth),
                    focusVisible: el.matches(':focus-visible')
                };
            });

        await page.focus('.lp-showcase-index a[href="#about-identity"]');
        const order = [(await active()).href];
        for (let i = 0; i < 5; i += 1) {
            await page.keyboard.press('Tab');
            order.push((await active()).href);
        }
        assert.deepEqual(
            order,
            CHAPTERS.map((c) => `#about-${c.slug}`),
            'Tab walks the chapters in order'
        );

        // Back one step by keyboard, so :focus-visible applies.
        await page.keyboard.press('Shift+Tab');
        const focus = await active();
        assert.equal(focus.href, '#about-nostr');
        assert.ok(focus.focusVisible);
        assert.equal(focus.outlineStyle, 'solid');
        assert.ok(focus.outlineWidth >= 2, 'a visible focus ring');

        const from = await page.evaluate(() => window.scrollY);
        await page.keyboard.press('Enter');
        await scrollRest(page, from);
        assert.equal(await page.evaluate(() => location.hash), '#about-nostr');
        const top = await page.evaluate(() => document.getElementById('about-nostr').getBoundingClientRect().top);
        assert.ok(Math.abs(top - 80) <= 1.5);
    } finally {
        await context.close();
    }
});

test('index rows stay the height they were, with a link filling each row', { skip: SKIP }, async () => {
    const { page, context } = await openAbout();
    try {
        await settled(page);
        const rows = await page.$$eval('.lp-showcase-index li', (items) =>
            items.map((li) => {
                const link = li.querySelector('a');
                const row = li.getBoundingClientRect();
                const box = link.getBoundingClientRect();
                return {
                    rowHeight: row.height,
                    linkFillsRow:
                        Math.abs(box.height - (row.height - 1)) <= 1.5 || Math.abs(box.height - row.height) <= 1.5,
                    numberShown: getComputedStyle(li, '::before').content,
                    linkColor: getComputedStyle(link).color,
                    rowColor: getComputedStyle(li).color,
                    underline: getComputedStyle(link).textDecorationLine
                };
            })
        );
        assert.equal(rows.length, 6);
        for (const [index, row] of rows.entries()) {
            assert.ok(row.linkFillsRow);
            assert.equal(
                row.numberShown,
                'counter(showcase, decimal-leading-zero)',
                `row ${index + 1} is still numbered`
            );
            assert.equal(row.linkColor, row.rowColor, 'text keeps the list colour');
            assert.equal(row.underline, 'none');
        }
    } finally {
        await context.close();
    }
});

// ── failure handling ────────────────────────────────────────────────────────

test('chapters that cannot be loaded degrade one by one, and Try again recovers them', { skip: SKIP }, async () => {
    let healthy = false;
    const failing = {
        '/content/about/consent.md': (pending) => pending.fulfill({ status: 500, body: 'boom' }),
        '/content/about/nostr.md': (pending) => pending.abort(),
        '/content/about/security.md': (pending) =>
            pending.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>app shell</body></html>' }),
        '/content/about/publishing.md': (pending) => pending.fulfill({ contentType: 'text/markdown', body: '  \n' })
    };
    const { page, context } = await openAbout({
        route: async (pending, url) => {
            const handler = failing[url.pathname];
            if (!handler || healthy) return false;
            await handler(pending);
            return true;
        }
    });
    try {
        await settled(page);
        assert.deepEqual(await states(page), ['ready', 'error', 'ready', 'error', 'error', 'error']);

        const errors = await page.$$eval('.lp-showcase-cards > article[data-about-state="error"]', (nodes) =>
            nodes.map((a) => ({
                id: a.id,
                title: a.querySelector(':scope > h3')?.textContent,
                alert: a.querySelector(':scope > p[role="alert"]')?.textContent,
                source: a.querySelector('a')?.getAttribute('href'),
                retry: a.querySelector(':scope > button[data-about-retry]')?.textContent,
                busy: a.hasAttribute('aria-busy')
            }))
        );
        assert.equal(errors.length, 4);
        for (const error of errors) {
            const chapter = CHAPTERS.find((c) => `about-${c.slug}` === error.id);
            assert.equal(error.title, chapter.label, 'named after its index entry');
            assert.match(error.alert, /could not be loaded/);
            assert.equal(error.source, `content/about/${chapter.slug}.md`);
            assert.equal(error.retry, 'Try again');
            assert.equal(error.busy, false);
        }

        // The page around the failures is intact.
        assert.equal(await page.locator('.lp-showcase-index a').count(), 6);
        assert.equal(await page.locator('#about-identity > .feature-grid').count(), 1);
        assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
            0
        );

        healthy = true;
        await page.click('#about-consent [data-about-retry]');
        await page.waitForFunction(() => document.getElementById('about-consent').dataset.aboutState === 'ready');
        assert.equal(await page.textContent('#about-consent > h3'), CHAPTERS[3].title);
        assert.deepEqual(await states(page), ['ready', 'error', 'ready', 'ready', 'error', 'error']);
    } finally {
        await context.close();
    }
});

test('a chapter shows a loading state until its file arrives', { skip: SKIP }, async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const { page, context } = await openAbout({
        route: async (pending, url) => {
            if (url.pathname !== '/content/about/identity.md') return false;
            await gate;
            await pending.continue();
            return true;
        }
    });
    try {
        await page.waitForFunction(() => document.querySelectorAll('[data-about-state="ready"]').length === 5);
        const waiting = await page.$eval('#about-identity', (a) => ({
            busy: a.getAttribute('aria-busy'),
            text: a.textContent.trim(),
            state: a.dataset.aboutState
        }));
        assert.deepEqual(waiting, { busy: 'true', text: 'Loading chapter…', state: 'loading' });

        release();
        await settled(page);
        assert.equal(await page.textContent('#about-identity > h3'), CHAPTERS[0].title);
    } finally {
        release();
        await context.close();
    }
});

test(
    'the GoFile note on the Publishing card is added after the chapter renders, and again after a retry',
    { skip: SKIP },
    async () => {
        let healthy = false;
        const { page, context } = await openAbout({
            route: async (pending, url) => {
                if (url.pathname !== '/content/about/publishing.md' || healthy) return false;
                await pending.fulfill({ status: 503, body: 'down' });
                return true;
            }
        });
        try {
            await settled(page);
            assert.equal(await page.locator('[data-gofile-default-note]').count(), 0, 'nothing to attach it to yet');

            healthy = true;
            await page.click('#about-publishing [data-about-retry]');
            await page.waitForFunction(
                () => document.getElementById('about-publishing').dataset.aboutState === 'ready'
            );
            assert.equal(await page.locator('#about-publishing > [data-gofile-default-note]').count(), 1);
            assert.match(
                await page.textContent('#about-publishing > [data-gofile-default-note]'),
                /preselected by default/
            );

            // And on an ordinary load it is there once the page has settled.
            const fresh = await openAbout();
            try {
                await settled(fresh.page);
                assert.equal(await fresh.page.locator('#about-publishing > [data-gofile-default-note]').count(), 1);
                assert.equal(
                    await fresh.page.evaluate(() =>
                        document
                            .getElementById('about-publishing')
                            .lastElementChild.hasAttribute('data-gofile-default-note')
                    ),
                    true
                );
            } finally {
                await fresh.context.close();
            }
        } finally {
            await context.close();
        }
    }
);

// ── sanitizing ──────────────────────────────────────────────────────────────

test('hostile Markdown is neutralised before it reaches the page', { skip: SKIP }, async () => {
    const hostile = [
        '# Evil <img src=x onerror="window.__pwned = 1">',
        '',
        '<script>window.__pwned = 2</script>',
        '',
        '<style>body { display: none }</style>',
        '',
        '[js](javascript:window.__pwned=3) <a href="https://example.com" target="_blank">blank</a> <a href="https://example.com" target="_top">top</a>',
        '',
        '<div style="position:fixed;inset:0" onclick="window.__pwned=4" class="ok">styled</div>',
        '',
        '<iframe src="https://example.com"></iframe> <form action="/x"><input name="q"><button>go</button></form>',
        '',
        '<svg onload="window.__pwned=6"><circle r="1"/></svg>',
        '',
        '::: feature-grid',
        '- <img src=x onerror="window.__pwned=5"> still a feature',
        ':::'
    ].join('\n');

    const { page, context } = await openAbout({
        route: async (pending, url) => {
            if (url.pathname !== '/content/about/identity.md') return false;
            await pending.fulfill({ contentType: 'text/markdown', body: hostile });
            return true;
        }
    });
    try {
        await settled(page);
        await page.waitForTimeout(250);

        const result = await page.evaluate(() => {
            const card = document.getElementById('about-identity');
            return {
                pwned: window.__pwned ?? null,
                forbidden: card.querySelectorAll(
                    'script, style, iframe, form, input, button, svg, [onerror], [onclick], [onload], [style]'
                ).length,
                jsLinks: [...card.querySelectorAll('a')].filter((a) =>
                    /^javascript:/i.test(a.getAttribute('href') || '')
                ).length,
                links: [...card.querySelectorAll('a[href^="https://example.com"]')].map((a) => ({
                    target: a.getAttribute('target'),
                    rel: a.getAttribute('rel')
                })),
                feature: card.querySelector('.feature-grid .feature')?.textContent.trim(),
                title: card.querySelector(':scope > h3')?.textContent,
                bodyVisible: getComputedStyle(document.body).display !== 'none',
                state: card.dataset.aboutState
            };
        });

        assert.equal(result.state, 'ready');
        assert.equal(result.pwned, null, 'no injected script ran');
        assert.equal(result.forbidden, 0);
        assert.equal(result.jsLinks, 0);
        assert.deepEqual(result.links, [
            { target: '_blank', rel: 'noopener noreferrer' },
            { target: null, rel: null }
        ]);
        assert.equal(result.feature, 'still a feature');
        assert.equal(result.title.trim(), 'Evil');
        assert.ok(result.bodyVisible);
    } finally {
        await context.close();
    }
});

test('rendering a chapter leaves the shared DOMPurify instance unconfigured', { skip: SKIP }, async () => {
    const { page, context } = await openAbout();
    try {
        await settled(page);
        // A default-configured sanitize keeps `target`'s default fate (dropped) and `style` handling as shipped.
        const outcome = await page.evaluate(() => {
            const out = document.createElement('div');
            out.append(
                DOMPurify.sanitize('<a href="https://example.com" target="_blank" style="color:red">x</a>', {
                    RETURN_DOM_FRAGMENT: true
                })
            );
            const link = out.querySelector('a');
            return { target: link.getAttribute('target'), style: link.getAttribute('style') };
        });
        assert.equal(outcome.target, null, 'no global ADD_ATTR leaked from the chapter sanitizer');
        assert.equal(outcome.style, 'color:red', 'no global FORBID_ATTR leaked from the chapter sanitizer');
    } finally {
        await context.close();
    }
});
