/**
 * The WebLLM tab, in a real browser.
 *
 * webllm-controller, webllm-engine and webllm-sw pin the logic with doubles.
 * What only a browser can show is checked here: that start-up loads nothing
 * WebLLM beyond the tab gate, that a device without WebGPU is told so, that
 * the WebLLM service worker registers on its own scope next to a live
 * peerweb-sw.js without taking over the page or its messages, that the
 * chat lays out on a desktop and a phone and renders model output as text,
 * that conversations are kept in this browser's IndexedDB per wallet, that
 * Continue, Delete, the settings dialog and the phone drawer work, and that
 * the MCP client gets through a real CORS preflight under MDN's policy.
 *
 * Needs Playwright with a Chromium build. Without them every test here is
 * skipped, with the reason in the report. The full application pulls its
 * dependencies from the network, so `/peerweb.min.js` is answered with a stub
 * that boots only the WebLLM tab gate; everything else is the real index.html,
 * styles.css, src/ and service workers served from this checkout. No model is
 * downloaded: the real engine needs WebGPU and the network, so the chat is
 * driven by a scripted engine behind the real controller and panel.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/** The tab gate, and a stand-in for setupAuthAwareUi's two WebLLM lines. */
const STUB_ENTRY = `
import { installWebLLMTab, setWebLLMAccess } from '/src/webllm/WebLLMTab.js';
installWebLLMTab();
window.__setSignedIn = (signedIn) => {
    document.querySelector('[data-tab="webllm"]').style.display = signedIn ? 'inline-flex' : 'none';
    document.getElementById('tab-webllm').style.display = signedIn ? '' : 'none';
    setWebLLMAccess(signedIn);
};
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
    if (pathname === '/peerweb.min.js') {
        response.writeHead(200, { 'content-type': TYPES['.js'] }).end(STUB_ENTRY);
        return;
    }
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

/** Open the app shell. Anything not served from this checkout is refused and recorded. */
async function openApp({ viewport = DESKTOP } = {}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const problems = [];
    const requests = [];
    const external = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    await context.route('**/*', (pending) => {
        const url = new URL(pending.request().url());
        if (url.origin !== ORIGIN) {
            external.push(url.href);
            return pending.abort();
        }
        requests.push(url.pathname);
        return pending.continue();
    });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => typeof window.__setSignedIn === 'function');
    return { page, context, problems, requests, external };
}

/**
 * Sign in and open the tab. `scripted` closes the real gate first, so the
 * real app (which would want WebGPU) never starts and a scripted controller
 * can own the panel.
 */
async function openWebLLMTab(page, viewport = DESKTOP, { scripted = false } = {}) {
    await page.evaluate(async (closeGate) => {
        window.__setSignedIn(true);
        if (closeGate) (await import('/src/webllm/WebLLMTab.js')).setWebLLMAccess(false);
    }, scripted);
    if (viewport.width <= 720) await page.click('#nav-toggle');
    await page.click('.tab-btn[data-tab="webllm"]');
}

/**
 * Bind the real controller and panel to a scripted engine.
 *
 * `wallet` turns on the real history store, in this browser's IndexedDB.
 * `continueChunks` is what Continue writes. `mdn` is a scripted MDN client:
 * 'ok' answers with a Clipboard API page, 'offline' fails like a dead network.
 */
async function startScriptedChat(
    page,
    chunks,
    result = { finishReason: 'stop' },
    { wallet = null, continueChunks = [' and so it ends.'], continueResult = { finishReason: 'stop' }, mdn = null } = {}
) {
    await page.evaluate(
        async ({
            chunks: replyChunks,
            result: replyResult,
            wallet: address,
            continueChunks: more,
            continueResult: moreResult,
            mdn: mdnMode
        }) => {
            const { WebLLMController } = await import('/src/webllm/WebLLMController.js');
            const { bindWebLLMPanel } = await import('/src/ui/webllm/WebLLMPanel.js');
            const { openWebLLMHistory } = await import('/src/webllm/webllmHistoryStore.js');
            const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
            const play = async (parts, onDelta, outcome) => {
                window.__interrupted = false;
                for (const chunk of parts) {
                    await tick();
                    if (window.__interrupted) return { finishReason: 'abort' };
                    onDelta(chunk);
                }
                return outcome;
            };
            window.__sent = [];
            const engine = {
                kind: 'worker',
                async load(onProgress) {
                    onProgress({ progress: 0.5, text: 'Fetching param cache[1/2]: 300MB fetched. 50% completed' });
                    await tick();
                    return { alreadyLoaded: false };
                },
                chat(messages, onDelta) {
                    window.__sent.push({ kind: 'chat', messages });
                    return play(replyChunks, onDelta, replyResult);
                },
                continue(messages, partial, onDelta) {
                    window.__sent.push({ kind: 'continue', messages, partial });
                    return play(more, onDelta, moreResult);
                },
                interrupt() {
                    window.__interrupted = true;
                },
                dispose() {}
            };
            window.__mdnCalls = [];
            const mdnClient = mdnMode && {
                async search(query) {
                    window.__mdnCalls.push(['search', query]);
                    if (mdnMode === 'offline') throw Object.assign(new Error('Failed to fetch'), { kind: 'network' });
                    return [
                        '# Clipboard API',
                        '`path`: `/en-US/docs/Web/API/Clipboard_API`',
                        'The Clipboard API provides the ability to respond to clipboard commands.'
                    ].join('\n');
                },
                async getDoc(path) {
                    window.__mdnCalls.push(['get-doc', path]);
                    return '# Clipboard API\n\nThe Clipboard API reads and writes the system clipboard asynchronously.';
                },
                async getCompat(key) {
                    window.__mdnCalls.push(['get-compat', key]);
                    throw new Error('not scripted');
                }
            };
            let render = () => {};
            const controller = new WebLLMController({
                detectWebGPU: async () => ({ supported: true, vendor: 'test', description: 'gpu' }),
                swClient: {
                    status: async () => ({ model: { state: 'absent', bytesCached: 0, bytesTotal: 0 } }),
                    prepareLibrary: async () => ({}),
                    clearModel: async () => {
                        window.__modelCleared = true;
                        return {};
                    }
                },
                createEngine: async () => engine,
                openHistory: (walletAddress) => openWebLLMHistory({ walletAddress }),
                mdnClient,
                onChange: (state, change) => render(state, change)
            });
            render = bindWebLLMPanel(controller);
            window.__controller = controller;
            controller.setAllowed(true, { walletAddress: address });
            await controller.activate();
        },
        { chunks, result, wallet, continueChunks, continueResult, mdn }
    );
}

/** Install, ask, and wait for the reply to finish. */
async function ask(page, question, { install = true } = {}) {
    if (install) {
        await page.click('#webllm-install-btn');
        await page.waitForSelector('#webllm-chat:not(.hidden)');
    }
    const before = await page.evaluate(() => window.__controller.state.messages.length);
    await page.fill('#webllm-input', question);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
        (count) => !window.__controller.state.generating && window.__controller.state.messages.length === count + 2,
        before
    );
}

// ── tests ───────────────────────────────────────────────────────────────────

test('start-up loads the tab gate and nothing else of WebLLM', { skip: SKIP }, async () => {
    const { page, context, problems, requests, external } = await openApp();
    try {
        assert.equal(await page.isHidden('.tab-btn[data-tab="webllm"]'), true, 'hidden until signed in');
        assert.equal(await page.isHidden('#tab-webllm'), true);

        await page.evaluate(() => window.__setSignedIn(true));
        assert.equal(await page.isVisible('.tab-btn[data-tab="webllm"]'), true);
        await page.waitForTimeout(150);

        const webllm = requests.filter((pathname) => /webllm/i.test(pathname));
        assert.deepEqual(webllm, ['/src/webllm/WebLLMTab.js']);
        assert.deepEqual(external, [], 'no CDN, model or GPU work at start-up');
        const registrations = await page.evaluate(async () =>
            (await navigator.serviceWorker.getRegistrations()).map((registration) => registration.scope)
        );
        assert.deepEqual(registrations, []);
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('without WebGPU the tab says so and offers no download', { skip: SKIP }, async () => {
    // Headless Chromium has no WebGPU adapter unless it is asked for one.
    const { page, context, problems, external } = await openApp();
    try {
        await openWebLLMTab(page);
        await page.waitForSelector('#webllm-error:not(.hidden)');
        assert.match(await page.textContent('#webllm-error'), /WebGPU is not available/);
        assert.equal(await page.isDisabled('#webllm-install-btn'), true);
        assert.equal((await page.textContent('#webllm-install-title')).trim(), 'Install Llama in Your Browser');
        assert.deepEqual(
            external.filter((url) => /web-llm|huggingface|binary-mlc/.test(url)),
            [],
            'nothing is downloaded for a device that cannot run it'
        );
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('the WebLLM service worker sits beside peerweb-sw.js without taking over', { skip: SKIP }, async () => {
    const { page, context, problems } = await openApp();
    try {
        // The app's worker, registered the way ServiceWorkerBridge does it.
        await page.evaluate(async () => {
            await navigator.serviceWorker.register('./peerweb-sw.js', { scope: '/' });
            await navigator.serviceWorker.ready;
        });
        await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/peerweb-sw.js'));

        const result = await page.evaluate(async () => {
            const appMessages = [];
            navigator.serviceWorker.addEventListener('message', (event) => appMessages.push(event.data?.type));
            const { createWebLLMServiceWorkerClient } = await import('/src/webllm/WebLLMServiceWorkerClient.js');
            const client = createWebLLMServiceWorkerClient();
            const ping = await client.ping();
            const status = await client.status();
            const registrations = (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
                scope: new URL(registration.scope).pathname,
                script: new URL(registration.active?.scriptURL || 'about:blank').pathname
            }));
            // The app's worker still answers the app's own requests.
            const manifest = await fetch('/manifest.json').then((response) => response.status);
            return {
                ping,
                status,
                registrations,
                controller: new URL(navigator.serviceWorker.controller.scriptURL).pathname,
                appMessages,
                manifest,
                cacheNames: await caches.keys()
            };
        });

        assert.equal(result.ping.version, 'webllm-sw-v1');
        assert.equal(result.status.model.state, 'absent');
        assert.deepEqual(
            result.registrations.sort((a, b) => a.scope.localeCompare(b.scope)),
            [
                { scope: '/', script: '/peerweb-sw.js' },
                { scope: '/webllm/', script: '/webllm-sw.js' }
            ]
        );
        assert.equal(result.controller, '/peerweb-sw.js', 'the page stays controlled by peerweb-sw.js');
        assert.deepEqual(result.appMessages, [], 'replies arrive on their own port, never on the app listener');
        assert.equal(result.manifest, 200);
        assert.deepEqual(result.cacheNames, [], 'a status check creates no caches');
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

for (const [name, viewport] of [
    ['desktop', DESKTOP],
    ['phone', PHONE]
]) {
    test(`the chat lays out on a ${name} and streams replies as text`, { skip: SKIP }, async () => {
        const { page, context, problems } = await openApp({ viewport });
        try {
            await openWebLLMTab(page, viewport, { scripted: true });
            await startScriptedChat(page, ['Hello', ' <img src=x onerror="window.__pwned=1">', ' from Llama.']);
            await page.click('#webllm-install-btn');
            await page.waitForSelector('#webllm-chat:not(.hidden)');
            assert.equal(await page.isHidden('#webllm-install'), true, 'the chat replaces the install screen');
            assert.equal((await page.textContent('#webllm-chat .dm-peer-label')).trim(), 'Llama 3.2 1B · Local AI');

            await page.fill('#webllm-input', 'Hi there');
            await page.keyboard.press('Enter');
            await page.waitForFunction(
                () => !window.__controller.state.generating && window.__controller.state.messages.length === 2
            );

            const bubbles = await page.$$eval('#webllm-messages .webllm-message', (items) =>
                items.map((item) => ({
                    own: item.classList.contains('is-own'),
                    text: item.querySelector('.channels-message-body').textContent,
                    mode: item.querySelector('.webllm-mode')?.textContent ?? null
                }))
            );
            assert.deepEqual(bubbles, [
                { own: true, text: 'Hi there', mode: null },
                {
                    own: false,
                    text: 'Hello <img src=x onerror="window.__pwned=1"> from Llama.',
                    mode: 'Informative · short answer'
                }
            ]);
            assert.equal(await page.$('#webllm-messages img'), null, 'model output is never markup');
            assert.equal(await page.evaluate(() => window.__pwned), undefined);

            const layout = await page.evaluate(() => {
                const composer = document.getElementById('webllm-composer').getBoundingClientRect();
                const chat = document.getElementById('webllm-chat').getBoundingClientRect();
                return {
                    overflow: document.documentElement.scrollWidth > window.innerWidth,
                    composerInside: composer.left >= chat.left - 1 && composer.right <= chat.right + 1,
                    chatFits: chat.width <= window.innerWidth
                };
            });
            assert.deepEqual(layout, { overflow: false, composerInside: true, chatFits: true });
            assert.deepEqual(problems, []);
        } finally {
            await context.close();
        }
    });
}

test(
    'a reply stopped by the loop guard says why, a cut-off one offers Continue, and a normal one says nothing',
    { skip: SKIP },
    async () => {
        const cases = [
            { chunks: ['Hello', ' there.'], result: { finishReason: 'stop' }, note: null, looped: false, more: false },
            {
                chunks: ['Hello there. ', 'Hello there. ', 'Hello there. '],
                result: { finishReason: 'loop', keepChars: 12 },
                note: /Stopped automatically: Llama started repeating itself/,
                looped: true,
                more: false
            },
            {
                chunks: ['A long answer that goes on and'],
                result: { finishReason: 'length' },
                note: null,
                looped: false,
                more: true
            },
            { chunks: ['Partial'], result: { finishReason: 'abort' }, note: /^Stopped\.$/, looped: false, more: false }
        ];
        for (const { chunks, result, note, looped, more } of cases) {
            const { page, context, problems } = await openApp();
            try {
                await openWebLLMTab(page, DESKTOP, { scripted: true });
                await startScriptedChat(page, chunks, result);
                await ask(page, 'hey');

                const reply = await page.$eval('#webllm-messages .webllm-message:not(.is-own)', (item) => ({
                    body: item.querySelector('.channels-message-body').textContent,
                    note: item.querySelector('.webllm-message-note')?.textContent ?? null,
                    looped: item.classList.contains('is-looped'),
                    more: Boolean(item.querySelector('.webllm-continue-btn'))
                }));
                if (note) assert.match(reply.note, note);
                else assert.equal(reply.note, null);
                assert.equal(reply.looped, looped);
                assert.equal(reply.more, more);
                if (result.finishReason === 'loop') assert.equal(reply.body, 'Hello there.', 'the repeats are cut');
                assert.deepEqual(problems, []);
            } finally {
                await context.close();
            }
        }
    }
);

test(
    'Continue → resumes the same reply in place, and is offered again only while it can go on',
    { skip: SKIP },
    async () => {
        const { page, context, problems } = await openApp();
        try {
            await openWebLLMTab(page, DESKTOP, { scripted: true });
            await startScriptedChat(
                page,
                ['First part of the answer'],
                { finishReason: 'length' },
                {
                    continueChunks: Array.from({ length: 60 }, (_, i) => ` more${i}`),
                    continueResult: { finishReason: 'length' }
                }
            );
            await ask(page, 'Explain closures');

            const button = '#webllm-messages .webllm-continue-btn';
            assert.equal((await page.textContent(button)).trim(), 'Continue →');
            assert.equal(await page.getAttribute(button, 'aria-label'), 'Continue this reply');
            await page.click(button);
            // Disabled while anything is generating; Stop stays available.
            await page.waitForFunction(() => window.__controller.state.generating);
            assert.equal(await page.isVisible('#webllm-stop-btn'), true);
            await page.waitForFunction(() => !window.__controller.state.generating);

            const after = await page.evaluate(() => ({
                bubbles: [...document.querySelectorAll('#webllm-messages .webllm-message')].map((item) => ({
                    own: item.classList.contains('is-own'),
                    text: item.querySelector('.channels-message-body').textContent
                })),
                sent: window.__sent.map(({ kind, partial }) => ({ kind, partial: partial ?? null }))
            }));
            assert.equal(after.bubbles.length, 2, 'no new message, user or assistant');
            assert.equal(after.bubbles[0].text, 'Explain closures');
            assert.ok(after.bubbles[1].text.startsWith('First part of the answer more0 more1'));
            assert.deepEqual(after.sent, [
                { kind: 'chat', partial: null },
                { kind: 'continue', partial: 'First part of the answer' }
            ]);
            // Cut off again, so it is offered again, on the same message.
            assert.equal(await page.$$eval(button, (items) => items.length), 1);

            // While a new reply streams, Continue on the earlier one is gone or disabled.
            await page.fill('#webllm-input', 'And then?');
            await page.keyboard.press('Enter');
            // Read in the same task that sees the reply generating.
            const offers = await (
                await page.waitForFunction(
                    (selector) =>
                        window.__controller.state.generating &&
                        [...document.querySelectorAll(selector)].map((item) => item.disabled),
                    button
                )
            ).jsonValue();
            assert.ok(offers.every(Boolean), 'no enabled Continue while generating');
            await page.waitForFunction(() => !window.__controller.state.generating);
            assert.equal(await page.$$eval(button, (items) => items.length), 1, 'only the latest reply offers it');
            assert.deepEqual(problems, []);
        } finally {
            await context.close();
        }
    }
);

test('the chat has no control that removes the downloaded model', { skip: SKIP }, async () => {
    const { page, context, problems } = await openApp();
    try {
        await openWebLLMTab(page, DESKTOP, { scripted: true });
        await startScriptedChat(page, ['Hi.'], { finishReason: 'stop' }, { wallet: '0xRemoveCheck' });
        await ask(page, 'hello');
        const labels = await page.$$eval('#tab-webllm button', (items) =>
            items.map((item) => `${item.textContent} ${item.getAttribute('aria-label') || ''}`.trim())
        );
        for (const label of labels) assert.doesNotMatch(label, /remove|uninstall|clear (the )?(model|cache)/i, label);

        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#webllm-delete-btn');
        await page.waitForFunction(() => window.__controller.state.conversations.length === 0);
        assert.equal(await page.evaluate(() => window.__modelCleared), undefined, 'deleting a chat keeps the model');
        assert.equal(await page.isVisible('#webllm-chat'), true, 'and the model stays loaded');
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

/** Count DOM changes inside the thread while a reply streams. */
async function watchThread(page) {
    await page.evaluate(() => {
        window.__mutations = 0;
        window.__observer?.disconnect();
        window.__observer = new MutationObserver((records) => {
            window.__mutations += records.length;
        });
        window.__observer.observe(document.getElementById('webllm-messages'), {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true
        });
    });
}

test('a streamed reply is drawn in batches, and every token reaches the screen', { skip: SKIP }, async () => {
    const chunks = Array.from({ length: 300 }, (_, i) => `w${i} `);
    const { page, context, problems } = await openApp();
    try {
        await openWebLLMTab(page, DESKTOP, { scripted: true });
        await startScriptedChat(page, chunks);
        await page.click('#webllm-install-btn');
        await page.waitForSelector('#webllm-chat:not(.hidden)');
        await page.fill('#webllm-input', 'Count for me');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__controller.state.messages[1]?.content.length > 0);
        await watchThread(page);
        await page.waitForFunction(() => !window.__controller.state.generating);

        const { mutations, shown, expected } = await page.evaluate(() => ({
            mutations: window.__mutations,
            shown: document.querySelector('#webllm-messages .webllm-message:not(.is-own) .channels-message-body')
                .textContent,
            expected: window.__controller.state.messages[1].content
        }));
        assert.equal(expected, chunks.join(''), 'nothing lost on the way in');
        assert.equal(shown, expected, 'nothing lost on the way to the screen');
        // ~300 deltas over ~1.5 s: drawn ~20 times, plus the final full render.
        assert.ok(mutations < 120, `${mutations} DOM mutations for ${chunks.length} deltas`);
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('Stop mid-stream shows everything generated so far, and New chat clears it', { skip: SKIP }, async () => {
    const chunks = Array.from({ length: 400 }, (_, i) => `t${i} `);
    const { page, context, problems } = await openApp();
    try {
        await openWebLLMTab(page, DESKTOP, { scripted: true });
        await startScriptedChat(page, chunks);
        await page.click('#webllm-install-btn');
        await page.waitForSelector('#webllm-chat:not(.hidden)');
        await page.fill('#webllm-input', 'Go');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__controller.state.messages[1]?.content.length > 100);
        await page.click('#webllm-stop-btn');
        await page.waitForFunction(() => !window.__controller.state.generating);

        const after = await page.evaluate(() => ({
            shown: document.querySelector('#webllm-messages .webllm-message:not(.is-own) .channels-message-body')
                .textContent,
            content: window.__controller.state.messages[1].content,
            note: document.querySelector('#webllm-messages .webllm-message-note')?.textContent
        }));
        assert.equal(after.shown, after.content, 'the last batch is flushed on Stop');
        assert.ok(after.content.length < chunks.join('').length);
        assert.equal(after.note, 'Stopped.');

        await page.click('#webllm-new-chat-btn');
        assert.equal(await page.$('#webllm-messages .webllm-message'), null);
        // Nothing from the old reply is drawn after New chat.
        await page.waitForTimeout(200);
        assert.equal(await page.$('#webllm-messages .webllm-message'), null);
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('the dev profile override is named in the chat, on a development host only', { skip: SKIP }, async () => {
    const { page, context } = await openApp();
    try {
        const profiles = await page.evaluate(async () => {
            const { resolveWebLLMProfile } = await import('/src/webllm/webllmConfig.js');
            return {
                here: resolveWebLLMProfile({
                    location: { hostname: location.hostname, search: '?webllm-profile=mobile' }
                }),
                prod: resolveWebLLMProfile({ location: { hostname: 'web25.cloud', search: '?webllm-profile=mobile' } })
            };
        });
        assert.equal(profiles.here.id, 'mobile');
        assert.equal(profiles.here.overridden, true);
        assert.equal(profiles.prod.overridden, false);

        await openWebLLMTab(page, DESKTOP, { scripted: true });
        await startScriptedChat(page, ['Hi.']);
        await page.evaluate(() => {
            window.__controller.profile = { id: 'mobile', contextWindow: 2048, maxTokens: 256, overridden: true };
        });
        await page.click('#webllm-install-btn');
        await page.waitForSelector('#webllm-chat:not(.hidden)');
        assert.match(await page.textContent('#webllm-chat-status'), /mobile profile \(dev\)/);
    } finally {
        await context.close();
    }
});

test(
    'conversations are saved in IndexedDB, listed by activity, and restored for the same wallet only',
    { skip: SKIP },
    async () => {
        const { page, context, problems } = await openApp();
        try {
            await openWebLLMTab(page, DESKTOP, { scripted: true });
            await startScriptedChat(page, ['Use const by default.'], { finishReason: 'stop' }, { wallet: '0xAAAA' });
            await ask(page, 'When should I use let instead of const in JavaScript?');
            await page.click('#webllm-new-chat-btn');
            assert.equal(await page.$('#webllm-messages .webllm-message'), null);
            await ask(page, 'How do CSS grid areas work?', { install: false });

            const listed = () =>
                page.$$eval('#webllm-conversations .webllm-conversation', (items) =>
                    items.map((item) => ({
                        title: item.querySelector('.webllm-conversation-title').textContent,
                        current: item.getAttribute('aria-current') === 'true'
                    }))
                );
            assert.deepEqual(await listed(), [
                { title: 'How do CSS grid areas work?', current: true },
                { title: 'When should I use let instead of const in…', current: false }
            ]);
            assert.equal((await page.textContent('#webllm-conversation-count')).trim(), '2');

            // Switching opens the other conversation's messages.
            await page.click('#webllm-conversations .webllm-conversation:not([aria-current])');
            await page.waitForFunction(() => window.__controller.state.messages[0]?.content.startsWith('When should'));
            assert.equal(
                await page.textContent('#webllm-messages .webllm-message.is-own .channels-message-body'),
                'When should I use let instead of const in JavaScript?'
            );

            // Lock and unlock as another wallet: nothing of the first is visible.
            const switchTo = (wallet) =>
                page.evaluate(async (address) => {
                    window.__controller.setAllowed(false);
                    window.__controller.setAllowed(true, { walletAddress: address });
                    await window.__controller.activate();
                }, wallet);
            // The scripted service worker reports no cached model, so each unlock installs again.
            const unlock = async (wallet) => {
                await switchTo(wallet);
                await page.click('#webllm-install-btn');
                await page.waitForSelector('#webllm-chat:not(.hidden)');
            };
            await unlock('0xBBBB');
            await page.waitForFunction(() => window.__controller.state.history === 'ready');
            assert.deepEqual(await listed(), []);
            assert.equal(await page.isVisible('#webllm-conversations-empty'), true);

            // And the first wallet gets its chats back, most recent first.
            await unlock('0xaaaa');
            await page.waitForFunction(() => window.__controller.state.conversations.length === 2);
            assert.equal((await listed())[0].title, 'How do CSS grid areas work?');
            const databases = await page.evaluate(async () =>
                (await indexedDB.databases()).map((db) => db.name).sort()
            );
            assert.equal(databases.filter((name) => name.startsWith('web25-webllm-history-')).length, 2);
            assert.ok(
                databases.every((name) => !/aaaa|bbbb/i.test(name)),
                'database names do not carry the wallet address'
            );
            assert.deepEqual(problems, []);
        } finally {
            await context.close();
        }
    }
);

test('saved conversations survive a reload of the page', { skip: SKIP }, async () => {
    const { page, context, problems } = await openApp();
    try {
        await openWebLLMTab(page, DESKTOP, { scripted: true });
        await startScriptedChat(
            page,
            ['Flexbox lays out in one dimension.'],
            { finishReason: 'stop' },
            { wallet: '0xCCCC' }
        );
        await ask(page, 'Flexbox or grid?');
        await page.reload();
        await page.waitForFunction(() => typeof window.__setSignedIn === 'function');
        await openWebLLMTab(page, DESKTOP, { scripted: true });
        await startScriptedChat(page, ['unused'], { finishReason: 'stop' }, { wallet: '0xCCCC' });
        await page.waitForFunction(() => window.__controller.state.messages.length === 2);
        const restored = await page.evaluate(() =>
            window.__controller.state.messages.map(({ role, content }) => `${role}: ${content}`)
        );
        assert.deepEqual(restored, ['user: Flexbox or grid?', 'assistant: Flexbox lays out in one dimension.']);
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('Delete removes only the current conversation, after confirmation', { skip: SKIP }, async () => {
    const { page, context, problems } = await openApp();
    try {
        await openWebLLMTab(page, DESKTOP, { scripted: true });
        await startScriptedChat(page, ['Answer.'], { finishReason: 'stop' }, { wallet: '0xDDDD' });
        await ask(page, 'First question');
        await page.click('#webllm-new-chat-btn');
        await ask(page, 'Second question', { install: false });

        let message = '';
        page.once('dialog', (dialog) => {
            message = dialog.message();
            void dialog.dismiss();
        });
        await page.click('#webllm-delete-btn');
        assert.match(message, /Delete this conversation\?.*The downloaded model is not affected\./);
        assert.equal(await page.evaluate(() => window.__controller.state.conversations.length), 2, 'declined');

        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#webllm-delete-btn');
        await page.waitForFunction(() => window.__controller.state.conversations.length === 1);
        assert.deepEqual(
            await page.$$eval('#webllm-conversations .webllm-conversation-title', (items) =>
                items.map((item) => item.textContent)
            ),
            ['First question']
        );
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('on a phone the conversation list is a drawer, and nothing overflows', { skip: SKIP }, async () => {
    const { page, context, problems } = await openApp({ viewport: PHONE });
    try {
        await openWebLLMTab(page, PHONE, { scripted: true });
        await startScriptedChat(page, ['Short answer.'], { finishReason: 'stop' }, { wallet: '0xEEEE' });
        await ask(page, 'What does Array.prototype.at do?');

        const geometry = () =>
            page.evaluate(() => {
                const sidebar = document.getElementById('webllm-sidebar').getBoundingClientRect();
                const shown = getComputedStyle(document.getElementById('webllm-sidebar')).visibility === 'visible';
                return {
                    overflow: document.documentElement.scrollWidth > window.innerWidth,
                    sidebarOnScreen: shown && sidebar.left >= -1 && sidebar.right <= window.innerWidth + 1,
                    expanded: document.getElementById('webllm-sidebar-toggle').getAttribute('aria-expanded')
                };
            });
        assert.equal(await page.isVisible('#webllm-sidebar-toggle'), true);
        assert.deepEqual(await geometry(), { overflow: false, sidebarOnScreen: false, expanded: 'false' });

        await page.click('#webllm-sidebar-toggle');
        await page.waitForTimeout(350);
        assert.deepEqual(await geometry(), { overflow: false, sidebarOnScreen: true, expanded: 'true' });
        assert.equal(await page.isVisible('#webllm-conversations .webllm-conversation'), true);

        // Choosing a conversation closes the drawer.
        await page.click('#webllm-conversations .webllm-conversation');
        await page.waitForTimeout(350);
        assert.deepEqual(await geometry(), { overflow: false, sidebarOnScreen: false, expanded: 'false' });

        // The header actions fit on the phone.
        const header = await page.evaluate(() =>
            ['webllm-new-chat-btn', 'webllm-settings-btn', 'webllm-delete-btn'].map((id) => {
                const box = document.getElementById(id).getBoundingClientRect();
                return box.width > 0 && box.right <= window.innerWidth;
            })
        );
        assert.deepEqual(header, [true, true, true]);
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('code in a reply is drawn as a code block with a Copy button, never as markup', { skip: SKIP }, async () => {
    const { page, context, problems } = await openApp({ viewport: DESKTOP });
    try {
        await openWebLLMTab(page, DESKTOP, { scripted: true });
        await startScriptedChat(page, [
            'Use **`debounce`**:\n\n```js\nconst',
            ' run = debounce(() => {}, 200);\n',
            '// <script>window.__pwned = 1</script>\n```\nDone.'
        ]);
        await ask(page, 'What is debounce?');
        const reply = await page.$eval('#webllm-messages .webllm-message:not(.is-own)', (item) => ({
            lang: item.querySelector('.webllm-code-lang')?.textContent,
            code: item.querySelector('.webllm-code pre code')?.textContent,
            codeClass: item.querySelector('.webllm-code pre code')?.className,
            inline: item.querySelector('strong .webllm-inline-code')?.textContent,
            copy: item.querySelector('[data-copy-code]')?.textContent,
            fences: item.querySelector('.channels-message-body').textContent.includes('```'),
            scripts: item.querySelectorAll('script').length
        }));
        assert.deepEqual(reply, {
            lang: 'js',
            code: 'const run = debounce(() => {}, 200);\n// <script>window.__pwned = 1</script>',
            codeClass: 'language-js',
            inline: 'debounce',
            copy: 'Copy',
            fences: false,
            scripts: 0
        });
        assert.equal(await page.evaluate(() => window.__pwned), undefined);
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('a productive request is planned, then written step by step under headings', { skip: SKIP }, async () => {
    const { page, context, problems } = await openApp({ viewport: DESKTOP });
    try {
        await openWebLLMTab(page, DESKTOP, { scripted: true });
        await startScriptedChat(page, ['1. Write the HTML form\n2. Add the validation script']);
        await ask(page, 'Create a login form with validation');
        const reply = await page.$eval('#webllm-messages .webllm-message:not(.is-own)', (item) => ({
            headings: [...item.querySelectorAll('.webllm-md-heading')].map((el) => el.textContent),
            mode: item.querySelector('.webllm-mode')?.textContent
        }));
        assert.deepEqual(reply, {
            headings: ['Step 1/2: Write the HTML form', 'Step 2/2: Add the validation script'],
            mode: 'Productive · 2 steps'
        });
        // One request for the plan, then one per step, each naming its step.
        const sent = await page.evaluate(() => window.__sent.map((entry) => entry.messages.at(-1).content));
        assert.equal(sent.length, 3);
        assert.match(sent[1], /Now do step 1 only: Write the HTML form/);
        assert.match(sent[2], /Now do step 2 only: Add the validation script/);
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('the settings dialog keeps the retention period and the MDN switch', { skip: SKIP }, async () => {
    const { page, context, problems } = await openApp();
    try {
        await openWebLLMTab(page, DESKTOP, { scripted: true });
        await startScriptedChat(page, ['Hi.'], { finishReason: 'stop' }, { wallet: '0xFFFF', mdn: 'ok' });
        await page.click('#webllm-install-btn');
        await page.waitForSelector('#webllm-chat:not(.hidden)');
        await page.waitForFunction(() => window.__controller.state.history === 'ready');

        await page.click('#webllm-settings-btn');
        await page.waitForSelector('#webllm-settings[open]');
        assert.equal(await page.inputValue('#webllm-retention'), '7d', 'a week by default');
        assert.deepEqual(
            await page.$$eval('#webllm-retention option', (items) => items.map((item) => item.textContent.trim())),
            ['1 day', '7 days', '30 days', 'Until manually deleted']
        );
        assert.equal(await page.isChecked('#webllm-mdn-toggle'), true);
        assert.match(await page.textContent('#webllm-settings'), /mcp\.mdn\.mozilla\.net/);

        await page.selectOption('#webllm-retention', '30d');
        await page.uncheck('#webllm-mdn-toggle');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#webllm-settings:not([open])', { state: 'attached' });
        await page.waitForFunction(() => window.__controller.state.settings.retention === '30d');

        // Off means no lookup at all, even for a web question.
        await ask(page, 'How do I use the Clipboard API?', { install: false });
        assert.deepEqual(await page.evaluate(() => window.__mdnCalls), []);

        // Both are kept for this wallet.
        const saved = await page.evaluate(async () => {
            const { openWebLLMHistory } = await import('/src/webllm/webllmHistoryStore.js');
            const store = await openWebLLMHistory({ walletAddress: '0xffff' });
            const settings = await store.getSettings();
            store.close();
            return settings;
        });
        // So is where the engine ran: the scripted engine is a worker.
        assert.deepEqual(saved, { retention: '30d', mdnEnabled: false, engine: 'worker' });
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test(
    'MDN results are credited with links that open safely, and an outage is said plainly',
    { skip: SKIP },
    async () => {
        for (const mode of ['ok', 'offline']) {
            const { page, context, problems } = await openApp();
            try {
                await openWebLLMTab(page, DESKTOP, { scripted: true });
                await startScriptedChat(
                    page,
                    ['Use navigator.clipboard.writeText().'],
                    { finishReason: 'stop' },
                    { mdn: mode }
                );
                await ask(page, 'How do I copy text with the Clipboard API?');

                const reply = await page.$eval('#webllm-messages .webllm-message:not(.is-own)', (item) => ({
                    links: [...item.querySelectorAll('.webllm-sources a')].map((link) => ({
                        text: link.textContent,
                        href: link.href,
                        target: link.target,
                        rel: link.rel
                    })),
                    note: item.querySelector('.webllm-message-note')?.textContent ?? null
                }));
                const searched = await page.evaluate(() => window.__mdnCalls[0]);
                assert.deepEqual(
                    searched,
                    ['search', 'copy text Clipboard'],
                    'only the search terms leave the browser'
                );
                const system = await page.evaluate(() => window.__sent[0].messages[0].content);
                if (mode === 'ok') {
                    assert.deepEqual(reply.links, [
                        {
                            text: 'MDN — Clipboard API',
                            href: 'https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API',
                            target: '_blank',
                            rel: 'noopener noreferrer'
                        }
                    ]);
                    assert.equal(reply.note, null);
                    assert.match(system, /MDN documentation retrieved[\s\S]*reads and writes the system clipboard/);
                } else {
                    assert.deepEqual(reply.links, []);
                    assert.match(reply.note, /MDN documentation couldn’t be reached/);
                    assert.doesNotMatch(system, /MDN documentation retrieved/);
                    assert.equal(
                        await page.textContent('#webllm-messages .webllm-message:not(.is-own) .channels-message-body'),
                        'Use navigator.clipboard.writeText().',
                        'the local answer still arrives'
                    );
                }
                assert.deepEqual(problems, []);
            } finally {
                await context.close();
            }
        }
    }
);

// ── the MCP client across origins ───────────────────────────────────────────

/**
 * A stand-in for mcp.mdn.mozilla.net on another origin, with the same CORS
 * policy as MDN's server: any origin, and only the headers it lists.
 */
const mdnServer = http.createServer(async (request, response) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version, X-Moz-1st-Party-Data-Opt-Out'
    };
    mdnServer.seen.push({ method: request.method, headers: request.headers });
    if (request.method === 'OPTIONS') {
        response.writeHead(204, cors);
        return response.end();
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (!('id' in message)) {
        response.writeHead(202, cors);
        return response.end();
    }
    const results = {
        initialize: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'mdn', version: 'test' }
        },
        'tools/call': {
            content: [{ type: 'text', text: '# Fetch API\n`path`: `/en-US/docs/Web/API/Fetch_API`\nFetch resources.' }]
        }
    };
    response.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: results[message.method] ?? {} }));
});
mdnServer.seen = [];
await new Promise((resolve) => mdnServer.listen(0, '127.0.0.1', resolve));
const MDN_ORIGIN_STANDIN = `http://localhost:${mdnServer.address().port}`;
after(() => mdnServer.close());

test('the MCP client passes a browser’s CORS preflight against MDN’s policy', { skip: SKIP }, async () => {
    // No request routing here: Playwright answers preflights itself for routed requests.
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    try {
        await page.goto(`${ORIGIN}/manifest.json`);
        mdnServer.seen = [];
        const text = await page.evaluate(async (endpoint) => {
            const { createMcpClient } = await import('/src/webllm/mdnMcpClient.js');
            return createMcpClient({ endpoint: `${endpoint}/` }).search('fetch');
        }, MDN_ORIGIN_STANDIN);
        assert.match(text, /# Fetch API/);
        const preflight = mdnServer.seen.find((entry) => entry.method === 'OPTIONS');
        assert.ok(preflight, 'a cross-origin preflight was made');
        assert.deepEqual(preflight.headers['access-control-request-headers'].split(',').sort(), [
            'content-type',
            'x-moz-1st-party-data-opt-out'
        ]);
        const posts = mdnServer.seen.filter((entry) => entry.method === 'POST');
        assert.equal(posts.length, 3, 'initialize, initialized, tools/call');
        for (const { headers } of posts) {
            assert.equal(headers['x-moz-1st-party-data-opt-out'], '1');
            assert.equal(headers.cookie, undefined);
            assert.equal(headers.referer, undefined);
        }
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});
