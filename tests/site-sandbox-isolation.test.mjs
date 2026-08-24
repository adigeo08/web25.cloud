/**
 * Security boundary #3 — torrent sites run in an isolated context.
 *
 * A `.torrentchain` signature proves provenance, not privilege: a site signed
 * by a malicious publisher is still untrusted code. These tests pin the frame's
 * sandbox tokens, the closed bridge allowlist, and the fact that the bridge can
 * only ever hand back files from the site's own bundle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import SiteSandbox from '../src/core/renderer/SiteSandbox.js';
import { buildSandboxBootstrapHtml } from '../src/core/renderer/SandboxBootstrap.js';
import {
    FORBIDDEN_SANDBOX_TOKENS,
    isSafeSandboxAttribute,
    isValidSandboxHandshake,
    normalizeBundlePath,
    SANDBOX_BRIDGE_OPS,
    SITE_SANDBOX_ATTRIBUTE,
    SITE_SANDBOX_TOKENS,
    validateBridgeRequest
} from '../src/core/renderer/SandboxBridgeProtocol.js';

const PARENT_ORIGIN = 'https://web25.cloud';
const HASH = 'a'.repeat(40);

// ─── sandbox attribute ───────────────────────────────────────────────────

test('the site frame is never granted same-origin or top-navigation privileges', () => {
    assert.ok(!SITE_SANDBOX_TOKENS.includes('allow-same-origin'));
    for (const token of FORBIDDEN_SANDBOX_TOKENS) {
        assert.ok(!SITE_SANDBOX_TOKENS.includes(token), `${token} must not be granted`);
    }
    assert.equal(isSafeSandboxAttribute(SITE_SANDBOX_ATTRIBUTE), true);
});

test('the previously shipped sandbox attribute is recognised as unsafe', () => {
    // This is the combination that let torrent JavaScript run as web25.cloud.
    assert.equal(isSafeSandboxAttribute('allow-scripts allow-same-origin allow-forms allow-popups allow-modals'), false);
    assert.equal(isSafeSandboxAttribute('allow-scripts allow-popups-to-escape-sandbox'), false);
    assert.equal(isSafeSandboxAttribute(''), false);
});

test('index.html ships the hardened sandbox attribute', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const match = html.match(/id="site-frame"[\s\S]{0,300}?sandbox="([^"]*)"/);
    assert.ok(match, 'the site frame declares a sandbox attribute');
    assert.equal(isSafeSandboxAttribute(match[1]), true, `unsafe sandbox attribute: ${match[1]}`);
});

test('the service worker forces an opaque origin on every /peerweb-site/ response', async () => {
    const require = createRequire(import.meta.url);
    global.self = {
        addEventListener: () => {},
        location: { origin: PARENT_ORIGIN },
        clients: { claim: async () => {}, matchAll: async () => [] },
        skipWaiting: () => {}
    };
    delete require.cache[require.resolve('../peerweb-sw.js')];
    const sw = require('../peerweb-sw.js');

    const isolated = sw.withSiteIsolationHeaders(new Response('<script>steal()</script>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
    }));

    const csp = isolated.headers.get('Content-Security-Policy');
    assert.ok(csp.startsWith('sandbox'), `expected a sandbox CSP, got: ${csp}`);
    assert.ok(!csp.includes('allow-same-origin'), 'the CSP sandbox must not restore same-origin');
    assert.equal(isolated.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(isolated.headers.get('Content-Type'), 'text/html');
    assert.equal(isolated.status, 200);
});

// ─── the bridge allowlist ────────────────────────────────────────────────

test('the bridge exposes no wallet, signing or auth operation', () => {
    assert.deepEqual(Object.values(SANDBOX_BRIDGE_OPS).sort(), [
        'resource.get',
        'sandbox.ready',
        'site.log',
        'site.title'
    ]);

    for (const op of Object.values(SANDBOX_BRIDGE_OPS)) {
        assert.ok(!/sign|wallet|key|auth|unlock|publish/i.test(op), `${op} exposes a privileged capability`);
    }
});

test('operations outside the allowlist are refused', () => {
    const forbidden = [
        'wallet.sign',
        'wallet.getPrivateKey',
        'auth.unlock',
        'SIGN_MESSAGE',
        'ECIES_DECRYPT',
        'eval',
        'resource.get '
    ];
    for (const op of forbidden) {
        assert.throws(() => validateBridgeRequest({ id: 'x', op }), /not allowed/, `${op} must be refused`);
    }

    assert.throws(() => validateBridgeRequest(null), /must be an object/);
    assert.throws(() => validateBridgeRequest({ op: 'sandbox.ready' }), /valid id/);
    assert.throws(() => validateBridgeRequest(['sandbox.ready']), /must be an object/);
});

test('resource.get cannot escape the site bundle', () => {
    const escapes = [
        '../../../etc/passwd',
        '/../secret',
        'https://web25.cloud/index.html',
        '//evil.example/x.js',
        'file:///etc/passwd',
        'a/../../b',
        'a\\..\\..\\b',
        'x\0y',
        ''
    ];
    for (const path of escapes) {
        assert.throws(() => normalizeBundlePath(path), /resource\.get/, `${JSON.stringify(path)} must be refused`);
    }

    assert.equal(normalizeBundlePath('/css/main.css?v=2#top'), 'css/main.css');
    assert.equal(normalizeBundlePath('assets/img/logo.png'), 'assets/img/logo.png');
});

// ─── the handshake ───────────────────────────────────────────────────────

test('the handshake only accepts the frame window, an opaque origin and the session token', () => {
    const frameWindow = { name: 'frame' };
    const expected = { token: 'tok', frameWindow };
    const good = { data: { type: 'WEB25_SANDBOX_HELLO', token: 'tok' }, origin: 'null', source: frameWindow };

    assert.equal(isValidSandboxHandshake(good, expected), true);
    assert.equal(isValidSandboxHandshake({ ...good, source: { other: true } }, expected), false, 'wrong window');
    assert.equal(isValidSandboxHandshake({ ...good, origin: PARENT_ORIGIN }, expected), false, 'non-opaque origin');
    assert.equal(
        isValidSandboxHandshake({ ...good, data: { type: 'WEB25_SANDBOX_HELLO', token: 'guess' } }, expected),
        false,
        'wrong token'
    );
    assert.equal(isValidSandboxHandshake({ ...good, data: { type: 'other', token: 'tok' } }, expected), false);
});

test('the bootstrap document embeds its config as data, never as source', () => {
    const html = buildSandboxBootstrapHtml({
        token: 'tok',
        parentOrigin: PARENT_ORIGIN,
        prefix: `/peerweb-site/${HASH}/</script><script>alert(1)</script>`
    });

    assert.ok(html.includes('type="application/json"'), 'config travels as JSON');
    assert.ok(!html.includes('</script><script>alert(1)'), 'injected markup is escaped');
    assert.ok(html.includes('WEB25_SANDBOX_HELLO'));
});

// ─── end-to-end over a real MessageChannel ───────────────────────────────

function bytes(text) {
    return new TextEncoder().encode(text);
}

const SITE_FILES = {
    'index.html': { content: bytes('<html><body>hi</body></html>'), type: 'text/html' },
    'app.js': { content: bytes('console.log(1)'), type: 'text/javascript' }
};

function startSandbox() {
    const frameWindow = {
        postMessage(message, targetOrigin, transfer) {
            frameWindow.received = { message, targetOrigin, port: transfer?.[0] || null };
        }
    };
    const iframe = {
        attributes: {},
        contentWindow: frameWindow,
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        removeAttribute(name) {
            // Mirror the DOM: content attributes and their reflected IDL
            // properties (srcdoc, src) come and go together.
            delete this.attributes[name];
            delete this[name];
        }
    };

    const listeners = new Set();
    const logs = [];
    const titles = [];
    global.window = {
        location: { origin: PARENT_ORIGIN },
        addEventListener: (name, listener) => {
            if (name === 'message') listeners.add(listener);
        },
        removeEventListener: (name, listener) => listeners.delete(listener)
    };

    const sandbox = new SiteSandbox({
        iframe,
        hash: HASH,
        entryFile: 'index.html',
        entryHtml: '<html><body>hi</body></html>',
        resolveFile: (path) => SITE_FILES[path] || null,
        onTitle: (title) => titles.push(title),
        log: (message) => logs.push(message)
    });
    sandbox.start();

    // The frame announces itself from its opaque origin.
    for (const listener of listeners) {
        listener({ data: { type: 'WEB25_SANDBOX_HELLO', token: sandbox.token }, origin: 'null', source: frameWindow });
    }

    const port = frameWindow.received?.port;
    assert.ok(port, 'the parent handed the frame a MessagePort');
    return { sandbox, iframe, port, logs, titles, listeners, frameWindow };
}

function ask(port, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bridge timeout')), 2000);
        port.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data);
        };
        port.start?.();
        port.postMessage(message);
    });
}

test('the sandbox frame is configured without allow-same-origin and gets no src', () => {
    const { iframe, sandbox } = startSandbox();
    assert.equal(isSafeSandboxAttribute(iframe.attributes.sandbox), true);
    assert.equal(iframe.attributes.src, undefined);
    assert.ok(iframe.srcdoc.includes('WEB25_SANDBOX_HELLO'));
    sandbox.destroy();
});

test('a hostile handshake never receives a bridge port', () => {
    const { sandbox, listeners, iframe } = startSandbox();
    sandbox.destroy();

    // A fresh sandbox, then an attacker guessing the handshake.
    const attackerWindow = { postMessage: () => assert.fail('attacker must not receive a port') };
    for (const listener of listeners) {
        listener({ data: { type: 'WEB25_SANDBOX_HELLO', token: 'guess' }, origin: 'null', source: attackerWindow });
        listener({ data: { type: 'WEB25_SANDBOX_HELLO', token: sandbox.token }, origin: PARENT_ORIGIN, source: iframe.contentWindow });
    }
});

test('sandbox.ready hands back the site entry document and nothing else', async () => {
    const { sandbox, port } = startSandbox();

    const response = await ask(port, { id: '1', op: 'sandbox.ready' });
    assert.equal(response.ok, true);
    assert.deepEqual(Object.keys(response.result).sort(), ['entryFile', 'entryHtml', 'hash', 'prefix']);
    assert.equal(response.result.hash, HASH);
    assert.equal(response.result.prefix, `/peerweb-site/${HASH}/`);

    sandbox.destroy();
});

test('resource.get serves bundle files and refuses everything else', async () => {
    const { sandbox, port } = startSandbox();

    const ok = await ask(port, { id: '2', op: 'resource.get', path: 'app.js' });
    assert.equal(ok.ok, true);
    assert.equal(new TextDecoder().decode(new Uint8Array(ok.result.bytes)), 'console.log(1)');
    assert.equal(ok.result.type, 'text/javascript');

    const missing = await ask(port, { id: '3', op: 'resource.get', path: 'not-there.js' });
    assert.equal(missing.ok, true);
    assert.equal(missing.result.bytes, null);

    const traversal = await ask(port, { id: '4', op: 'resource.get', path: '../../../etc/passwd' });
    assert.equal(traversal.ok, false);
    assert.equal(traversal.error, 'operation-not-allowed');

    sandbox.destroy();
});

test('a malicious site cannot invoke wallet, signing or auth operations over the bridge', async () => {
    const { sandbox, port, logs } = startSandbox();

    for (const [index, op] of ['wallet.sign', 'auth.getPrivateKey', 'SIGN_MESSAGE', 'eval'].entries()) {
        const response = await ask(port, { id: `evil-${index}`, op, message: 'give me the key' });
        assert.equal(response.ok, false);
        assert.equal(response.error, 'operation-not-allowed');
    }

    assert.ok(logs.some((line) => line.includes('Rejected bridge message')));
    sandbox.destroy();
});

test('site.title and site.log are accepted but carry no privilege', async () => {
    const { sandbox, port, titles, logs } = startSandbox();

    assert.equal((await ask(port, { id: '5', op: 'site.title', title: 'My site' })).ok, true);
    assert.equal(titles[0], 'My site');

    assert.equal((await ask(port, { id: '6', op: 'site.log', message: 'hello' })).ok, true);
    assert.ok(logs.some((line) => line.includes('[Sandboxed site] hello')));

    sandbox.destroy();
});

test('destroying the sandbox closes the bridge', async () => {
    const { sandbox, port, iframe } = startSandbox();
    sandbox.destroy();

    assert.equal(iframe.srcdoc, undefined);
    await assert.rejects(() => ask(port, { id: '7', op: 'sandbox.ready' }), /timeout/);
});
