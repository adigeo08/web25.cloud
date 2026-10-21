/**
 * The WebLLM tab, in a real browser.
 *
 * webllm-controller, webllm-engine and webllm-sw pin the logic with doubles.
 * What only a browser can show is checked here: that start-up loads nothing
 * WebLLM beyond the tab gate, that a device without WebGPU is told so, that
 * the WebLLM service worker registers on its own scope next to a live
 * peerweb-sw.js without taking over the page or its messages, and that the
 * chat lays out on a desktop and a phone and renders model output as text.
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

/** Bind the real controller and panel to a scripted engine. */
async function startScriptedChat(page, chunks, result = { finishReason: 'stop' }) {
    await page.evaluate(
        async ({ chunks: replyChunks, result: replyResult }) => {
            const { WebLLMController } = await import('/src/webllm/WebLLMController.js');
            const { bindWebLLMPanel } = await import('/src/ui/webllm/WebLLMPanel.js');
            const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
            const engine = {
                kind: 'worker',
                async load(onProgress) {
                    onProgress({ progress: 0.5, text: 'Fetching param cache[1/2]: 300MB fetched. 50% completed' });
                    await tick();
                    return { alreadyLoaded: false };
                },
                async chat(_messages, onDelta) {
                    for (const chunk of replyChunks) {
                        await tick();
                        onDelta(chunk);
                    }
                    return replyResult;
                },
                interrupt() {},
                dispose() {}
            };
            let render = () => {};
            const controller = new WebLLMController({
                detectWebGPU: async () => ({ supported: true, vendor: 'test', description: 'gpu' }),
                swClient: {
                    status: async () => ({ model: { state: 'absent', bytesCached: 0, bytesTotal: 0 } }),
                    prepareLibrary: async () => ({}),
                    clearModel: async () => ({})
                },
                createEngine: async () => engine,
                onChange: (state, change) => render(state, change)
            });
            render = bindWebLLMPanel(controller);
            window.__controller = controller;
            controller.setAllowed(true);
            await controller.activate();
        },
        { chunks, result }
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
                items.map((item) => ({ own: item.classList.contains('is-own'), text: item.textContent }))
            );
            assert.deepEqual(bubbles, [
                { own: true, text: 'Hi there' },
                { own: false, text: 'Hello <img src=x onerror="window.__pwned=1"> from Llama.' }
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

test('a reply stopped by the loop guard or the length limit says why, as text, and a normal one says nothing', async () => {
    const cases = [
        { chunks: ['Hello', ' there.'], result: { finishReason: 'stop' }, note: null, looped: false },
        {
            chunks: ['Hello there. ', 'Hello there. ', 'Hello there. '],
            result: { finishReason: 'loop', keepChars: 12 },
            note: /Stopped automatically: Llama started repeating itself/,
            looped: true
        },
        {
            chunks: ['A long answer that goes on and'],
            result: { finishReason: 'length' },
            note: /reached the length limit/,
            looped: false
        },
        { chunks: ['Partial'], result: { finishReason: 'abort' }, note: /^Stopped\.$/, looped: false }
    ];
    for (const { chunks, result, note, looped } of cases) {
        const { page, context, problems } = await openApp();
        try {
            await openWebLLMTab(page, DESKTOP, { scripted: true });
            await startScriptedChat(page, chunks, result);
            await page.click('#webllm-install-btn');
            await page.waitForSelector('#webllm-chat:not(.hidden)');
            await page.fill('#webllm-input', 'hey');
            await page.keyboard.press('Enter');
            await page.waitForFunction(
                () => !window.__controller.state.generating && window.__controller.state.messages.length === 2
            );

            const reply = await page.$eval('#webllm-messages .webllm-message:not(.is-own)', (item) => ({
                body: item.querySelector('.channels-message-body').textContent,
                note: item.querySelector('.webllm-message-note')?.textContent ?? null,
                looped: item.classList.contains('is-looped')
            }));
            if (note) assert.match(reply.note, note);
            else assert.equal(reply.note, null);
            assert.equal(reply.looped, looped);
            if (result.finishReason === 'loop') assert.equal(reply.body, 'Hello there.', 'the repeats are cut');
            assert.deepEqual(problems, []);
        } finally {
            await context.close();
        }
    }
});
