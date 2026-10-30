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
 * `profile` ('desktop' or 'mobile') is the profile the controller runs; by
 * default the controller's own, desktop.
 */
async function startScriptedChat(
    page,
    chunks,
    result = { finishReason: 'stop' },
    {
        wallet = null,
        continueChunks = [' and so it ends.'],
        continueResult = { finishReason: 'stop' },
        mdn = null,
        decision = 'short',
        plan = null,
        project = false,
        profile = null,
        replaced = null
    } = {}
) {
    await page.evaluate(
        async ({
            chunks: replyChunks,
            result: replyResult,
            wallet: address,
            continueChunks: more,
            continueResult: moreResult,
            mdn: mdnMode,
            decision: autoMode,
            plan: planSteps,
            project: withProject,
            profile: profileId,
            replaced: replacedModels
        }) => {
            const { WebLLMController } = await import('/src/webllm/WebLLMController.js');
            const { bindWebLLMPanel } = await import('/src/ui/webllm/WebLLMPanel.js');
            const { openWebLLMThoughts } = await import('/src/webllm/webllmThoughtStore.js');
            const { openWebLLMHistory } = await import('/src/webllm/webllmHistoryStore.js');
            const { WEBLLM_PROFILES } = await import('/src/webllm/webllmConfig.js');
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
                async load(onProgress, loadProfile) {
                    window.__loadedProfile = loadProfile;
                    onProgress({ progress: 0.5, text: 'Fetching param cache[1/2]: 300MB fetched. 50% completed' });
                    await tick();
                    return { alreadyLoaded: false };
                },
                async chat(messages, onDelta, options = {}) {
                    // Structured answers: Auto's decision and the plan.
                    if (options.schema) {
                        const deciding = Boolean(options.schema.properties?.mode);
                        window.__sent.push({ kind: deciding ? 'decide' : 'plan', messages, schema: options.schema });
                        await tick();
                        onDelta(JSON.stringify(deciding ? { mode: autoMode } : { steps: planSteps || [] }));
                        return { finishReason: 'stop' };
                    }
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
                    },
                    // What a phone deleted to make room for SmolLM2, when scripted.
                    ...(replacedModels ? { clearReplacedModels: async () => replacedModels } : {})
                },
                createEngine: async () => engine,
                profile: profileId ? { ...WEBLLM_PROFILES[profileId] } : undefined,
                openHistory: (walletAddress) => openWebLLMHistory({ walletAddress }),
                // The real thought store, in this browser; no CDN here, so recall runs without idb-vector.
                openThoughts: (walletAddress) => openWebLLMThoughts({ walletAddress }),
                mdnClient,
                onChange: (state, change) => {
                    render(state, change);
                    window.__project?.handle(state, change);
                }
            });
            // The conversation's project, as WebLLMApp wires it: this browser's
            // real OPFS, with no CDN for git, so files are saved uncommitted.
            let project = null;
            let renderProject = () => {};
            let workbench = null;
            if (withProject) {
                const { WebLLMProject } = await import('/src/webllm/chatProject.js');
                let available = false;
                project = new WebLLMProject({
                    controller,
                    onChange: (state) => {
                        renderProject(state);
                        if (state.available !== available) {
                            available = state.available;
                            render(controller.state);
                        }
                    }
                });
                window.__project = project;
            }
            const panel = bindWebLLMPanel(controller, {
                project,
                onOpenCanvas: (snippet) => void workbench?.openSnippet(snippet)
            });
            render = panel;
            if (project) {
                // The micro IDE, as WebLLMApp wires it. No CDN here: git commits
                // are skipped and the editor is the plain fallback.
                const { bindWebLLMWorkbench } = await import('/src/ui/webllm/WebLLMWorkbench.js');
                workbench = bindWebLLMWorkbench({ project, controller, sidebar: panel.sidebar, confirm: () => true });
                renderProject = workbench.renderProject;
                renderProject(project.state);
                window.__workbench = workbench;
            }
            window.__controller = controller;
            controller.setAllowed(true, { walletAddress: address });
            await controller.activate();
        },
        { chunks, result, wallet, continueChunks, continueResult, mdn, decision, plan, project, profile, replaced }
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
                    mode: 'Short · chosen by Llama'
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
    'a repeating reply is shown whole, a cut-off one offers Continue, and a normal one says nothing',
    { skip: SKIP },
    async () => {
        const cases = [
            { chunks: ['Hello', ' there.'], result: { finishReason: 'stop' }, note: null, more: false },
            {
                // No loop guard: repeats are the model's, shown as written.
                chunks: ['Hello there. ', 'Hello there. ', 'Hello there.'],
                result: { finishReason: 'stop' },
                note: null,
                more: false,
                body: 'Hello there. Hello there. Hello there.'
            },
            {
                chunks: ['A long answer that goes on and'],
                result: { finishReason: 'length' },
                note: null,
                more: true
            },
            { chunks: ['Partial'], result: { finishReason: 'abort' }, note: /^Stopped\.$/, more: false }
        ];
        for (const { chunks, result, note, more, body } of cases) {
            const { page, context, problems } = await openApp();
            try {
                await openWebLLMTab(page, DESKTOP, { scripted: true });
                await startScriptedChat(page, chunks, result);
                await ask(page, 'hey');

                const reply = await page.$eval('#webllm-messages .webllm-message:not(.is-own)', (item) => ({
                    body: item.querySelector('.channels-message-body').textContent,
                    note: item.querySelector('.webllm-message-note')?.textContent ?? null,
                    more: Boolean(item.querySelector('.webllm-continue-btn'))
                }));
                if (note) assert.match(reply.note, note);
                else assert.equal(reply.note, null);
                assert.equal(reply.more, more);
                if (body) assert.equal(reply.body, body, 'nothing is cut');
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
                sent: window.__sent
                    .filter(({ kind }) => kind !== 'decide')
                    .map(({ kind, partial }) => ({ kind, partial: partial ?? null }))
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

test('on a phone the tab installs and names SmolLM2 360M, and Auto is chosen by it', { skip: SKIP }, async () => {
    const { page, context, problems } = await openApp({ viewport: PHONE });
    try {
        await openWebLLMTab(page, PHONE, { scripted: true });
        await startScriptedChat(
            page,
            ['Closures keep their scope.'],
            { finishReason: 'stop' },
            {
                profile: 'mobile',
                replaced: [{ modelId: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 1B', removed: 9 }]
            }
        );
        await page.waitForSelector('#webllm-install-btn:not([disabled])');
        // The Llama this phone held is gone, and the install screen says why.
        assert.match(
            await page.textContent('#webllm-device'),
            /^Llama 3\.2 1B was removed from this device to make room for SmolLM2 360M\. WebGPU ready/
        );
        const deviceLine = await page.textContent('#webllm-device');

        const install = await page.evaluate(() => ({
            title: document.getElementById('webllm-install-title').textContent.trim(),
            lede: document.querySelector('.webllm-install-lede').textContent.trim(),
            size: document.querySelector('.webllm-facts li:first-child b').textContent,
            button: document.getElementById('webllm-install-btn').textContent.trim(),
            footer: document.querySelector('.webllm-footer').textContent.replace(/\s+/g, ' ').trim(),
            license: document.getElementById('webllm-license-link').getAttribute('href')
        }));
        assert.deepEqual(install, {
            title: 'Install SmolLM in Your Browser',
            lede: install.lede,
            size: '~250 MB',
            button: 'Install SmolLM2 360M',
            footer: 'SmolLM2 by Hugging Face · Apache License 2.0',
            license: 'https://www.apache.org/licenses/LICENSE-2.0'
        });
        assert.match(install.lede, /^Download SmolLM directly into your browser/);
        assert.doesNotMatch(
            (await page.textContent('#webllm-install')).replace(deviceLine, ''),
            /Llama/,
            'apart from the removal note, the install screen is SmolLM2’s'
        );

        await page.click('#webllm-install-btn');
        await page.waitForSelector('#webllm-chat:not(.hidden)');
        assert.equal(
            await page.evaluate(() => window.__loadedProfile.model),
            'smollm',
            'the engine is asked for SmolLM2'
        );
        assert.equal((await page.textContent('#webllm-chat .dm-peer-label')).trim(), 'SmolLM2 360M · Local AI');
        assert.equal((await page.textContent('.webllm-empty-title')).trim(), 'SmolLM is ready');

        await page.fill('#webllm-input', 'What is a closure?');
        await page.press('#webllm-input', 'Enter');
        await page.waitForFunction(() => window.__controller.state.generating === false && window.__sent.length >= 2);
        assert.equal(await page.inputValue('#webllm-reply-mode'), 'auto', 'Auto stays the default on a phone');
        assert.deepEqual(
            await page.evaluate(() => window.__sent.map((entry) => entry.kind)),
            ['decide', 'chat'],
            "on Auto the phone's model decides how to answer"
        );
        assert.equal((await page.textContent('.webllm-mode')).trim(), 'Short · chosen by SmolLM');
        assert.doesNotMatch(await page.textContent('#webllm-chat'), /Llama/);
        assert.deepEqual(problems, []);
    } finally {
        await context.close();
    }
});

test('on a phone, code cut by the reply limit can still be named, previewed and saved', { skip: SKIP }, async () => {
    const { page, context, problems } = await openApp({ viewport: PHONE });
    try {
        await openWebLLMTab(page, PHONE, { scripted: true });
        await startScriptedChat(
            page,
            ['Here:\n\n```html index.html\n<h1>Hi</h1>\n<p>more'],
            { finishReason: 'length' },
            {
                profile: 'mobile',
                project: true,
                wallet: '0x00000000000000000000000000000000000000c1',
                decision: 'short'
            }
        );
        await page.waitForSelector('#webllm-install-btn:not([disabled])');
        await page.click('#webllm-install-btn');
        await page.waitForSelector('#webllm-chat:not(.hidden)');
        await page.fill('#webllm-input', 'Make a page');
        await page.press('#webllm-input', 'Enter');
        await page.waitForSelector('.webllm-code [data-save-code]');

        assert.equal(await page.inputValue('.webllm-code .webllm-code-name'), 'index.html');
        assert.equal(await page.isVisible('.webllm-code [data-open-canvas]'), true, 'Preview is offered');
        assert.equal(await page.isVisible('.webllm-continue button, [aria-label="Continue this reply"]'), true);
        assert.deepEqual(await page.evaluate(() => window.__project.state.files), [], 'not saved by itself');

        await page.click('.webllm-code [data-save-code]');
        await page.waitForFunction(() => window.__project.state.files.includes('index.html'));
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

test(
    'the micro IDE: sidebar panels, a project tree saved in one go, and a canvas that previews and edits',
    { skip: SKIP },
    async () => {
        const { page, context, problems } = await openApp({ viewport: DESKTOP });
        try {
            await openWebLLMTab(page, DESKTOP, { scripted: true });
            await startScriptedChat(
                page,
                [
                    '```html index.html\n<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>' +
                        '<body><h1>Hi</h1><script src="app.js"></script></body></html>\n```\n',
                    'Then:\n```css\nh1 { color: red; }\n```\nAnd:\n```js app.js\nconsole.log("hello from app");\n```'
                ],
                undefined,
                { wallet: '0xcdcd', project: true }
            );
            await page.waitForFunction(() => window.__controller.state.history === 'ready');
            await page.waitForFunction(() => window.__project.state.available);
            await ask(page, 'Make a page');

            // The sidebar starts open on a desktop; × closes it and its button reopens it.
            assert.equal(await page.isVisible('#webllm-panel-conversations'), true);
            await page.click('#webllm-sidebar-close');
            assert.equal(await page.isHidden('#webllm-sidebar'), true);
            assert.equal(await page.getAttribute('#webllm-sidebar-toggle', 'aria-expanded'), 'false');
            await page.click('#webllm-sidebar-toggle');
            assert.equal(await page.isVisible('#webllm-sidebar'), true);

            // The project button swaps the panel; pressing it again closes the sidebar.
            await page.click('#webllm-project-toggle');
            assert.equal(await page.isVisible('#webllm-panel-project'), true);
            assert.equal(await page.isHidden('#webllm-panel-conversations'), true);
            assert.equal(await page.getAttribute('#webllm-project-toggle', 'aria-pressed'), 'true');
            const rows = () =>
                page.$$eval('#webllm-tree .webllm-tree-row', (items) => items.map((el) => el.dataset.row));
            await page.waitForFunction(() => document.querySelectorAll('#webllm-tree .webllm-tree-row').length === 2);
            assert.deepEqual(await rows(), ['app.js', 'index.html']);

            // The unnamed stylesheet, saved from the chat under the name it suggests.
            await page.click('#webllm-messages [data-save-code="1"]');
            await page.waitForFunction(() => document.querySelectorAll('#webllm-tree .webllm-tree-row').length === 3);

            // A new folder and a drag into it are a draft until Save.
            await page.click('#webllm-tree-new-folder');
            await page.fill('#webllm-tree-new-name', 'css');
            await page.press('#webllm-tree-new-name', 'Enter');
            await page.dragAndDrop('[data-row="style.css"]', '[data-row="css"]');
            assert.equal(await page.textContent('#webllm-tree-pending-label'), '2 changes');
            assert.deepEqual(await page.evaluate(() => window.__project.state.files), [
                'app.js',
                'index.html',
                'style.css'
            ]);
            await page.click('#webllm-tree-save');
            await page.waitForFunction(() => window.__project.state.files.includes('css/style.css'));
            await page.waitForSelector('#webllm-tree-pending', { state: 'hidden' });
            assert.deepEqual(await rows(), ['css', 'css/style.css', 'app.js', 'index.html']);

            // Up a level with the arrow, then Discard puts it back.
            await page.hover('[data-row="css/style.css"]');
            await page.click('[data-row="css/style.css"] [data-tree-action="up"]');
            assert.deepEqual(await rows(), ['css', 'app.js', 'index.html', 'style.css']);
            await page.click('#webllm-tree-discard');
            assert.deepEqual(await rows(), ['css', 'css/style.css', 'app.js', 'index.html']);

            // Preview on a snippet: the page, its script inlined, its console below.
            await page.click('#webllm-messages [data-open-canvas="0"]');
            await page.waitForSelector('#webllm-canvas:not(.hidden)');
            const frame = page.frameLocator('#webllm-canvas-frame');
            assert.equal(await frame.locator('h1').textContent(), 'Hi');
            await page.waitForFunction(
                () => document.getElementById('webllm-canvas-console-count').textContent === '1'
            );
            assert.equal(await page.textContent('#webllm-canvas-console-log'), 'hello from app');
            assert.equal(await page.textContent('#webllm-canvas-status'), 'Saved');
            // The sandbox has no way back into the app's origin.
            assert.equal(await page.getAttribute('#webllm-canvas-frame', 'sandbox'), 'allow-scripts allow-modals');

            // Edit in Code (the plain editor here: no CDN), save with the keyboard.
            await page.click('#webllm-canvas-tab-code');
            await page.waitForSelector('.webllm-canvas-textarea');
            assert.match(await page.textContent('#webllm-canvas-editor-note'), /plain editor/);
            await page.fill('.webllm-canvas-textarea', '<h1>Edited</h1>');
            assert.equal(await page.textContent('#webllm-canvas-status'), 'Unsaved changes');
            await page.press('.webllm-canvas-textarea', 'Control+s');
            await page.waitForFunction(() => document.getElementById('webllm-canvas-status').textContent === 'Saved');
            assert.equal(await page.evaluate(() => window.__project.readFile('index.html')), '<h1>Edited</h1>');
            await page.click('#webllm-canvas-tab-preview');
            assert.equal(await frame.locator('h1').textContent(), 'Edited');

            // Saved into the thought store too, and recalled into Llama's next prompt.
            await page.evaluate(() => window.__project.whenIdle());
            const titles = await page.evaluate(async () => {
                const listed = await window.__controller.thoughts.listSequences({
                    conversationId: window.__controller.state.activeConversationId
                });
                return listed.value.sequences.map((sequence) => sequence.title);
            });
            assert.ok(titles.includes('Project file: index.html'));
            await ask(page, 'Make the heading on index.html blue', { install: false });
            const system = await page.evaluate(
                () => window.__sent.filter((entry) => entry.kind === 'chat').at(-1).messages[0].content
            );
            assert.match(system, /The user's project, as saved in the canvas:[\s\S]*<h1>Edited<\/h1>/);

            // Deploy project sends the reorganised tree, as a folder.
            await page.evaluate(() => {
                window.addEventListener('web25:stage-deploy', (event) => {
                    window.__staged = event.detail.files.map((file) => file.webkitRelativePath);
                });
            });
            await page.click('#webllm-deploy-project-btn');
            await page.waitForFunction(() => Array.isArray(window.__staged));
            assert.deepEqual(await page.evaluate(() => window.__staged), [
                'make-a-page/app.js',
                'make-a-page/css/style.css',
                'make-a-page/index.html'
            ]);
            assert.deepEqual(problems, []);
        } finally {
            await context.close();
        }
    }
);

test(
    'Auto: Llama chooses Thinking, plans in JSON, and writes each step from its recalled thoughts',
    { skip: SKIP },
    async () => {
        const { page, context, problems } = await openApp({ viewport: DESKTOP });
        try {
            await openWebLLMTab(page, DESKTOP, { scripted: true });
            await startScriptedChat(page, ['```html\n<form id="login"></form>\n```'], undefined, {
                wallet: '0xabab',
                decision: 'thinking',
                plan: ['Write the login form markup', 'Add the login form validation script']
            });
            await page.waitForFunction(() => window.__controller.state.history === 'ready');
            await ask(page, 'Create a login form with validation');
            const reply = await page.$eval('#webllm-messages .webllm-message:not(.is-own)', (item) => ({
                headings: [...item.querySelectorAll('.webllm-md-heading')].map((el) => el.textContent),
                code: [...item.querySelectorAll('.webllm-code pre code')].map((el) => el.textContent),
                mode: item.querySelector('.webllm-mode')?.textContent
            }));
            assert.deepEqual(reply, {
                headings: ['Step 1/2: Write the login form markup', 'Step 2/2: Add the login form validation script'],
                code: ['<form id="login"></form>', '<form id="login"></form>'],
                mode: 'Thinking · 2 steps · chosen by Llama'
            });
            // Decide, plan, then one request per step, each naming its step; the
            // second step is given the first one back, recalled from the thought store.
            const sent = await page.evaluate(() =>
                window.__sent.map((entry) => ({ kind: entry.kind, last: entry.messages.at(-1).content }))
            );
            assert.deepEqual(
                sent.map((entry) => entry.kind),
                ['decide', 'plan', 'chat', 'chat']
            );
            assert.match(sent[2].last, /Now do step 1 only: Write the login form markup/);
            assert.match(sent[3].last, /Earlier thoughts:[\s\S]*Thought 2:[\s\S]*<form id="login"><\/form>/);
            assert.match(sent[3].last, /Now do step 2 only: Add the login form validation script/);

            // The thoughts were kept: plan and two steps, one completed sequence.
            const stored = await page.evaluate(async () => {
                const { sequenceId } = window.__controller.state.messages.at(-1);
                const history = await window.__controller.thoughts.getHistory({ sequenceId, limit: 10 });
                const state = await window.__controller.thoughts.getSequenceState(sequenceId);
                return {
                    numbers: history.value.thoughts.map((t) => t.thoughtNumber),
                    completed: state.value.completed
                };
            });
            assert.deepEqual(stored, { numbers: [1, 2, 3], completed: true });
            assert.deepEqual(problems, []);
        } finally {
            await context.close();
        }
    }
);

test('the settings dialog keeps the retention period, the reply mode and the MDN switch', { skip: SKIP }, async () => {
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
        assert.equal(await page.inputValue('#webllm-reply-mode'), 'auto', 'Llama chooses by default');
        assert.deepEqual(await page.$$eval('#webllm-reply-mode option', (items) => items.map((item) => item.value)), [
            'auto',
            'short',
            'thinking'
        ]);

        await page.selectOption('#webllm-retention', '30d');
        await page.selectOption('#webllm-reply-mode', 'short');
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
        assert.deepEqual(saved, { retention: '30d', mdnEnabled: false, engine: 'worker', replyMode: 'short' });
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
                const system = await page.evaluate(
                    () => window.__sent.find((entry) => entry.kind === 'chat').messages[0].content
                );
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

test(
    'idb-vector loads verified from its pinned jsDelivr files and recalls thoughts in a real browser',
    { skip: SKIP },
    async () => {
        const { page, context, problems, external } = await openApp({ viewport: DESKTOP });
        try {
            // jsDelivr serves npm files verbatim: answer with the package's own bytes.
            const served = [];
            await context.route('https://cdn.jsdelivr.net/npm/idb-vector@0.2.0/**', async (pending) => {
                const file = new URL(pending.request().url()).pathname.replace('/npm/idb-vector@0.2.0/', '');
                served.push(file);
                await pending.fulfill({
                    status: 200,
                    contentType: 'text/javascript',
                    headers: { 'access-control-allow-origin': '*' },
                    body: await readFile(new URL(`../node_modules/idb-vector/${file}`, import.meta.url))
                });
            });
            const result = await page.evaluate(async () => {
                const { loadIdbVector } = await import('/src/webllm/idbVectorLoader.js');
                const { openWebLLMThoughts } = await import('/src/webllm/webllmThoughtStore.js');
                const VectorDB = await loadIdbVector();
                const store = await openWebLLMThoughts({
                    walletAddress: '0xcdcd',
                    vectors: async (dbName) => new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' })
                });
                await store.vectorsReady;
                const add = (sequenceId, thoughtNumber, thought) =>
                    store.appendThought({
                        conversationId: 'c1',
                        sequenceId,
                        thought,
                        thoughtNumber,
                        totalThoughts: 3,
                        nextThoughtNeeded: true
                    });
                const first = await add(null, 1, 'Draw a bar chart on a canvas');
                await add(first.value.sequenceId, 2, 'The login form with an email input and a submit button');
                const third = await add(first.value.sequenceId, 3, 'Header and footer styles');
                // Indexing runs in the background; the thought is stored already.
                await store.whenIndexed();
                const stored = await store.getThought({
                    sequenceId: first.value.sequenceId,
                    thoughtId: third.value.thought.id
                });
                const recalled = await store.recall({
                    query: 'Validate the email input of the login form',
                    conversationId: 'c1',
                    limit: 1
                });
                return {
                    indexed: stored.value.thoughts[0].vectorKey !== null,
                    recalled: recalled.map((thought) => thought.thought),
                    databases: (await indexedDB.databases()).map((db) => db.name).sort()
                };
            });
            assert.deepEqual(served.sort(), ['index.js', 'utils/sortedarray.js']);
            assert.equal(result.indexed, true, 'thoughts are indexed in idb-vector');
            assert.deepEqual(result.recalled, ['The login form with an email input and a submit button']);
            assert.equal(result.databases.length, 2);
            assert.ok(result.databases.some((name) => name.startsWith('web25-webllm-thoughts-')));
            assert.ok(result.databases.some((name) => name.startsWith('web25-webllm-thought-vectors-')));
            assert.deepEqual(problems, []);
            assert.deepEqual(external, [], 'nothing else left the page');
        } finally {
            await context.close();
        }
    }
);

test(
    'a version 1 thought database is upgraded in place: its thoughts are kept, indexed late, and recalled by conversation',
    { skip: SKIP },
    async () => {
        const { page, context, problems } = await openApp({ viewport: DESKTOP });
        try {
            await context.route('https://cdn.jsdelivr.net/npm/idb-vector@0.2.0/**', async (pending) => {
                const file = new URL(pending.request().url()).pathname.replace('/npm/idb-vector@0.2.0/', '');
                await pending.fulfill({
                    status: 200,
                    contentType: 'text/javascript',
                    headers: { 'access-control-allow-origin': '*' },
                    body: await readFile(new URL(`../node_modules/idb-vector/${file}`, import.meta.url))
                });
            });
            const result = await page.evaluate(async () => {
                const { thoughtsDatabaseName, openWebLLMThoughts } = await import('/src/webllm/webllmThoughtStore.js');
                const { loadIdbVector } = await import('/src/webllm/idbVectorLoader.js');
                const name = await thoughtsDatabaseName('0xeeee');
                // The schema as version 1 wrote it, with thoughts stored before
                // idb-vector ever loaded.
                await new Promise((resolve, reject) => {
                    const request = indexedDB.open(name, 1);
                    request.onupgradeneeded = () => {
                        const db = request.result;
                        db.createObjectStore('sequences', { keyPath: 'sequenceId' }).createIndex(
                            'byConversation',
                            'conversationId'
                        );
                        const thoughts = db.createObjectStore('thoughts', { keyPath: 'id' });
                        thoughts.createIndex('bySequence', 'sequenceId');
                        thoughts.createIndex('byClientRequest', 'clientRequestId');
                    };
                    request.onsuccess = () => {
                        const db = request.result;
                        const tx = db.transaction(['sequences', 'thoughts'], 'readwrite');
                        const base = {
                            completed: false,
                            thoughtCount: 1,
                            lastThoughtNumber: 1,
                            totalThoughts: 2,
                            lastThoughtPreview: '',
                            branches: [],
                            createdAt: 1,
                            updatedAt: 1,
                            messageId: null,
                            title: 't'
                        };
                        tx.objectStore('sequences').put({ ...base, sequenceId: 's1', conversationId: 'c1' });
                        tx.objectStore('sequences').put({ ...base, sequenceId: 's2', conversationId: 'c2' });
                        const thought = (id, sequenceId, conversationId, text, ordinal) => ({
                            id,
                            ordinal,
                            sequenceId,
                            conversationId,
                            thought: text,
                            thoughtNumber: 1,
                            totalThoughts: 2,
                            nextThoughtNeeded: true,
                            isRevision: false,
                            revisesThought: null,
                            branchFromThought: null,
                            branchId: 'main',
                            needsMoreThoughts: false,
                            clientRequestId: null,
                            fingerprint: id,
                            vectorKey: null,
                            createdAt: 1
                        });
                        tx.objectStore('thoughts').put(
                            thought('t1', 's1', 'c1', 'The login form with an email input and a submit button', 1)
                        );
                        tx.objectStore('thoughts').put(
                            thought('t2', 's2', 'c2', 'Another conversation: the login form email input', 2)
                        );
                        tx.oncomplete = () => {
                            db.close();
                            resolve(undefined);
                        };
                        tx.onerror = () => reject(tx.error);
                    };
                    request.onerror = () => reject(request.error);
                });
                const VectorDB = await loadIdbVector();
                const store = await openWebLLMThoughts({
                    walletAddress: '0xeeee',
                    vectors: async (dbName) => new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' })
                });
                await store.whenIndexed();
                const upgraded = await new Promise((resolve) => {
                    const tx = store.db.transaction(['thoughts'], 'readonly');
                    resolve({
                        version: store.db.version,
                        indexes: [...tx.objectStore('thoughts').indexNames].sort(),
                        stores: [...store.db.objectStoreNames].sort()
                    });
                });
                const vectorKeys = await store.run(
                    ['thoughts'],
                    'readonly',
                    (tx) =>
                        new Promise((resolve) => {
                            const request = tx.objectStore('thoughts').getAll();
                            request.onsuccess = () => resolve(request.result.map((t) => t.vectorKey !== null));
                        })
                );
                const recalled = await store.recall({
                    query: 'validate the login form email',
                    conversationId: 'c1',
                    limit: 3
                });
                await store.deleteConversation('c1');
                const after = await store.recall({
                    query: 'validate the login form email',
                    conversationId: 'c1',
                    limit: 3
                });
                return { upgraded, vectorKeys, recalled: recalled.map((t) => t.id), after: after.length };
            });
            assert.deepEqual(result.upgraded, {
                version: 2,
                indexes: ['byClientRequest', 'byConversation', 'bySequence'],
                stores: ['sequences', 'thoughts', 'vectorTombstones']
            });
            assert.deepEqual(result.vectorKeys, [true, true], 'thoughts from before are backfilled into idb-vector');
            assert.deepEqual(result.recalled, ['t1'], 'only this conversation');
            assert.equal(result.after, 0);
            assert.deepEqual(problems, []);
        } finally {
            await context.close();
        }
    }
);
