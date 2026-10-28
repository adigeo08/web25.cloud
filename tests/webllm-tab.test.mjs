/**
 * The WebLLM tab: its markup, who may see it, and what loads when.
 *
 * Signed-in only, exactly like Chat — hidden in the markup and revealed by
 * setupAuthAwareUi for an unlocked, onboarded identity. Opening it is the
 * first time any WebLLM code beyond the tab gate is imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFakeDom } from './helpers/fake-dom.mjs';
import {
    LLAMA_LICENSE_URL,
    WEBLLM_LIBRARY_URL,
    WEBLLM_MODEL_ID,
    WEBLLM_VERSION,
    createAppConfig
} from '../src/webllm/webllmConfig.js';

const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

/** The WebLLM panel's markup alone. */
function panel() {
    const start = MARKUP.indexOf('<div id="tab-webllm"');
    return MARKUP.slice(start, MARKUP.indexOf('<!-- ── BROWSE TAB ── -->', start));
}

const squash = (text) => text.replace(/\s+/g, ' ').trim();

test('the tab ships hidden, next to Chat, with its panel hidden too', () => {
    assert.match(
        MARKUP,
        /<button class="tab-btn" data-tab="webllm" role="tab" aria-selected="false" style="display: none">/
    );
    assert.match(MARKUP, /<div id="tab-webllm" class="tab-panel" role="tabpanel" style="display: none">/);
    const nav = MARKUP.slice(MARKUP.indexOf('<nav id="primary-nav"'), MARKUP.indexOf('</nav>'));
    assert.ok(nav.indexOf('data-tab="channels"') < nav.indexOf('data-tab="webllm"'));
    assert.ok(nav.indexOf('data-tab="webllm"') < nav.indexOf('data-tab="about"'));
});

test('the install screen says exactly what the model is and does, in English', () => {
    const html = panel();
    assert.match(html, /<h2 id="webllm-install-title">Install Llama in Your Browser<\/h2>/);
    assert.match(
        squash(html),
        /Download Llama directly into your browser and chat with a local AI\. The model runs entirely on your device, without external inference servers\. Once downloaded, it stays cached for future sessions\./
    );
    // One model, one install button, and no way to remove the model from here.
    const install = html.slice(html.indexOf('<section id="webllm-install"'), html.indexOf('</section>'));
    assert.equal(install.match(/Install Llama/g).length, 2, 'the title and the one button');
    assert.equal(install.match(/<button/g).length, 1);
    assert.doesNotMatch(html, /webllm-remove|webllm-legacy|Remove model/i);
    assert.match(squash(install), /<button id="webllm-install-btn"[^>]*> Install Llama 3\.2 1B <\/button>/);
    // Meta's attribution and the official license.
    assert.match(squash(install), /Llama 3\.2 by Meta · © Meta Platforms, Inc\./);
    assert.ok(install.includes(`href="${LLAMA_LICENSE_URL}"`));
    assert.match(install, /rel="noopener noreferrer"/);
});

test('the chat re-uses the messenger’s look with its own ids, and none of its controls', () => {
    const html = panel();
    assert.match(squash(html), /<span class="dm-peer-label">Llama 3\.2 1B · Local AI<\/span>/);
    assert.match(html, /class="quick-upload card-base dm-app webllm-app hidden"/);
    assert.match(html, /id="webllm-messages"\s+class="channels-messages webllm-messages"/);
    assert.match(html, /id="webllm-send-btn" type="submit" class="dm-send-btn"/);
    // No element of the Direct Messenger is duplicated into this tab.
    assert.doesNotMatch(html, /id="(dm-|channels-)/);
});

test('the library is the official package on jsDelivr, at a pinned version, for one model', () => {
    assert.match(WEBLLM_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(WEBLLM_LIBRARY_URL, `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/lib/index.js`);
    assert.equal(WEBLLM_MODEL_ID, 'Llama-3.2-1B-Instruct-q4f32_1-MLC');
    const config = createAppConfig();
    assert.equal(config.model_list.length, 1);
    assert.equal(config.model_list[0].model_id, WEBLLM_MODEL_ID);
});

test('start-up imports only the tab gate, and the gate imports nothing', () => {
    const main = read('src/main.js');
    assert.match(main, /import \{ installWebLLMTab \} from '\.\/webllm\/WebLLMTab\.js';/);
    assert.doesNotMatch(main, /WebLLMApp|WebLLMController|webllm-worker|webllm-sw/);

    const gate = read('src/webllm/WebLLMTab.js');
    assert.doesNotMatch(gate, /^import /m, 'no static imports: the app is loaded on demand');
    assert.match(gate, /import\('\.\/WebLLMApp\.js'\)/);

    const lifecycle = read('src/core/bootstrap/Lifecycle.js');
    const webllmImports = lifecycle.match(/from '[^']*webllm[^']*'/g);
    assert.deepEqual(webllmImports, ["from '../../webllm/WebLLMTab.js'"]);
    // index.html registers no new worker and loads no WebLLM script itself.
    assert.doesNotMatch(MARKUP, /webllm-sw\.js|web-llm/);
});

test('the WebLLM code talks to no other WEB25 service', () => {
    const files = [
        'src/webllm/WebLLMApp.js',
        'src/webllm/WebLLMController.js',
        'src/webllm/WebLLMEngineClient.js',
        'src/webllm/WebLLMServiceWorkerClient.js',
        'src/webllm/WebLLMTab.js',
        'src/webllm/webllmEngineHost.js',
        'src/webllm/webllm-worker.js',
        'src/webllm/webllmConfig.js',
        'src/webllm/webllmProgress.js',
        'src/webllm/webgpuSupport.js',
        'src/webllm/webllmHistoryStore.js',
        'src/webllm/webllmPromptFormat.js',
        'src/webllm/mdnMcpClient.js',
        'src/webllm/mdnLookup.js',
        'src/webllm/webllmThinking.js',
        'src/ui/webllm/WebLLMPanel.js',
        'src/ui/webllm/replyFormat.js',
        'webllm-sw.js'
    ];
    // Code only: the comments explain what is avoided, by name.
    const code = (file) =>
        read(file)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
    for (const file of files) {
        const source = code(file);
        assert.doesNotMatch(
            source,
            /from '[^']*(nostr|channels|auth|torrent|gofile|core)\//i,
            `${file} imports app internals`
        );
        assert.doesNotMatch(source, /RTCPeerConnection|WebSocket|serviceWorker\.controller|localStorage/, file);
        // Saved chats are the one database, and it is WebLLM's own.
        if (file !== 'src/webllm/webllmHistoryStore.js') assert.doesNotMatch(source, /indexedDB\.open/, file);
    }
    assert.match(code('src/webllm/webllmHistoryStore.js'), /WEBLLM_HISTORY_DB_PREFIX = 'web25-webllm-history-'/);
    // Besides downloading WebLLM and the model, the only request the chat makes
    // is to MDN's MCP endpoint, without cookies.
    for (const file of [
        'src/webllm/WebLLMController.js',
        'src/webllm/webllmHistoryStore.js',
        'src/webllm/mdnLookup.js',
        'src/ui/webllm/WebLLMPanel.js'
    ]) {
        assert.doesNotMatch(code(file), /\bfetch\(|XMLHttpRequest|sendBeacon/, file);
    }
    assert.match(code('src/webllm/mdnMcpClient.js'), /credentials: 'omit'/);
    assert.match(code('src/webllm/webllmConfig.js'), /MDN_MCP_ENDPOINT = 'https:\/\/mcp\.mdn\.mozilla\.net\/'/);
    // Model output is only ever text.
    assert.doesNotMatch(read('src/ui/webllm/WebLLMPanel.js'), /innerHTML|insertAdjacentHTML/);
    assert.doesNotMatch(read('src/ui/webllm/replyFormat.js'), /innerHTML|insertAdjacentHTML|outerHTML|DOMParser/);
});

// ── auth gating through the real setupAuthAwareUi ───────────────────────────

function installGatingDom() {
    const installed = installFakeDom({
        browseTab: { tag: 'button', attrs: { 'data-tab': 'browse' }, classes: ['tab-btn'] },
        publishTab: { tag: 'button', attrs: { 'data-tab': 'publish' }, classes: ['tab-btn'] },
        authTab: { tag: 'button', attrs: { 'data-tab': 'auth' }, classes: ['tab-btn'] },
        channelsTab: { tag: 'button', attrs: { 'data-tab': 'channels' }, classes: ['tab-btn'] },
        webllmTab: { tag: 'button', attrs: { 'data-tab': 'webllm', style: 'display: none' }, classes: ['tab-btn'] },
        webllmPanel: { tag: 'div', id: 'tab-webllm' },
        wall: { tag: 'section', id: 'deploy-auth-wall' },
        deployPanel: { tag: 'div', id: 'deploy-panel', classes: ['hidden'] }
    });
    installed.nodes.webllmTab.style.display = 'none';
    installed.nodes.webllmPanel.style.display = 'none';
    return installed;
}

async function context(state) {
    const lifecycle = await import('../src/core/bootstrap/Lifecycle.js');
    return {
        ...lifecycle,
        log() {},
        toast: { info() {}, warning() {}, error() {}, success() {} },
        authController: { state },
        nostrDmSession: { started: false, start: async () => {}, stop() {} },
        applyResumeHint: () => ({ restored: true }),
        ensureGoFileCredential: async () => 'present',
        restoreDeploySession: async () => {},
        refreshPagesPanel: async () => {}
    };
}

const signedIn = (overrides = {}) => ({
    localWalletExists: true,
    localWalletUnlocked: true,
    address: '0xabc',
    identityType: 'local',
    nostrEnabled: false,
    seedBackupPending: false,
    seedBackupInterrupted: false,
    ...overrides
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('only an unlocked, onboarded identity sees the WebLLM tab', async () => {
    const dom = installGatingDom();
    try {
        const locked = signedIn({ localWalletUnlocked: false, address: null, identityType: null });
        const peerweb = await context(locked);
        peerweb.setupAuthAwareUi.call(peerweb, locked);
        assert.equal(dom.nodes.webllmTab.style.display, 'none');
        assert.equal(dom.nodes.webllmPanel.style.display, 'none');

        // Unlocked but still on the recovery-phrase backup step: not signed in.
        const onboarding = signedIn({ seedBackupPending: true });
        peerweb.setupAuthAwareUi.call(peerweb, onboarding);
        assert.equal(dom.nodes.webllmTab.style.display, 'none');

        const unlocked = signedIn();
        peerweb.setupAuthAwareUi.call(peerweb, unlocked);
        await flush();
        assert.equal(dom.nodes.webllmTab.style.display, 'inline-flex');
        assert.equal(dom.nodes.webllmPanel.style.display, '');
    } finally {
        dom.restore();
    }
});

test('locking the wallet while on WebLLM hides it and moves to Search', async () => {
    const dom = installGatingDom();
    try {
        const peerweb = await context(signedIn());
        peerweb.setupAuthAwareUi.call(peerweb, signedIn());
        await flush();

        dom.nodes.webllmTab.classList.add('active');
        let movedToSearch = 0;
        dom.nodes.browseTab.addEventListener('click', () => {
            movedToSearch += 1;
        });
        peerweb.setupAuthAwareUi.call(
            peerweb,
            signedIn({ localWalletUnlocked: false, address: null, identityType: null })
        );

        assert.equal(dom.nodes.webllmTab.style.display, 'none');
        assert.equal(dom.nodes.webllmPanel.style.display, 'none');
        assert.equal(movedToSearch, 1);
    } finally {
        dom.restore();
    }
});

test('the tab gate loads the app only when a signed-in user opens the tab, and locks it with the wallet', async () => {
    const dom = installFakeDom({
        nav: { tag: 'nav', classes: ['tab-nav'] }
    });
    const button = dom.document.createElement('button');
    button.classList.add('tab-btn');
    button.setAttribute('data-tab', 'webllm');
    dom.nodes.nav.appendChild(button);

    const gate = await import('../src/webllm/WebLLMTab.js');
    gate.resetWebLLMTabForTests();
    const calls = { loads: 0, allowed: [], activations: 0 };
    const controller = {
        setAllowed: (allowed) => calls.allowed.push(allowed),
        activate: async () => {
            calls.activations += 1;
        }
    };
    try {
        gate.installWebLLMTab({
            loadApp: async () => {
                calls.loads += 1;
                return controller;
            }
        });
        gate.installWebLLMTab(); // a second install binds nothing more

        button.click();
        await flush();
        assert.equal(calls.loads, 0, 'nothing loads for a signed-out click');

        gate.setWebLLMAccess(true);
        await flush();
        assert.equal(calls.loads, 0, 'signing in alone loads nothing');

        button.click();
        await flush();
        button.click();
        await flush();
        assert.equal(calls.loads, 1, 'the app is imported once');
        assert.equal(calls.activations, 2);
        assert.deepEqual(calls.allowed, [true, true]);

        gate.setWebLLMAccess(false);
        await flush();
        assert.deepEqual(calls.allowed, [true, true, false]);
    } finally {
        gate.resetWebLLMTabForTests();
        dom.restore();
    }
});
