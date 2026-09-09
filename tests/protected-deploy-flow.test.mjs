/**
 * The Preview & Protect step, and what the rest of the deploy flow sees.
 *
 * The point of the step is that it changes what gets signed and nothing else:
 * a publisher who protects nothing lands back in the flow that shipped before
 * this feature, and one who protects something hands the *encrypted* site to
 * the same bundling, seeding and mirroring code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

import * as ecies from '../src/channels/ecies.js';
import { installDeployDom } from './helpers/fake-deploy-dom.mjs';
import { textContentOf } from '../src/torrent/AuthoringDom.js';
import { prepareAuthoringDocument } from '../src/torrent/ProtectedTextLocator.js';
import { newUuid } from '../src/torrent/ProtectedAssetProtocol.js';
import { validateBridgeRequest, SANDBOX_BRIDGE_OPS } from '../src/core/renderer/SandboxBridgeProtocol.js';
import { buildSandboxBootstrapHtml } from '../src/core/renderer/SandboxBootstrap.js';
import SiteSandbox from '../src/core/renderer/SiteSandbox.js';

const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const OWNER_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const GUEST_KEY = '0x2222222222222222222222222222222222222222222222222222222222222222';
const OWNER_PUB = ecies.getPublicKeyFromPrivateKey(OWNER_KEY);
const GUEST_PUB = ecies.getPublicKeyFromPrivateKey(GUEST_KEY);
const OWNER_ADDRESS = ecies.evmAddressFromPublicKey(OWNER_PUB);

const SITE_HTML = '<html><body><p id="a">Open text. <b>Secret text</b> end.</p></body></html>';

if (typeof globalThis.CompressionStream === 'undefined') {
    globalThis.CompressionStream = class {
        constructor(format) {
            if (format !== 'gzip') throw new Error('Unsupported format');
            const transform = new TransformStream({
                transform(chunk, controller) {
                    controller.enqueue(new Uint8Array(gzipSync(chunk)));
                }
            });
            this.readable = transform.readable;
            this.writable = transform.writable;
        }
    };
    globalThis.DecompressionStream = class {
        constructor(format) {
            if (format !== 'gzip') throw new Error('Unsupported format');
            const transform = new TransformStream({
                transform(chunk, controller) {
                    controller.enqueue(new Uint8Array(gunzipSync(chunk)));
                }
            });
            this.readable = transform.readable;
            this.writable = transform.writable;
        }
    };
}

function stagedFile(path, text, type = 'text/html') {
    const bytes = new TextEncoder().encode(text);
    return {
        name: path.split('/').pop(),
        path,
        webkitRelativePath: path,
        type,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
}

/** The locator the preview frame would report for a run of text. */
function locatorFor(html, needle, path = 'index.html') {
    const document_ = prepareAuthoringDocument(html, path);
    let containerId = null;
    for (const [id, element] of document_.previewIndex) {
        if (element.tag !== 'p' && element.tag !== 'div') continue;
        if (textContentOf(element).includes(needle)) containerId = id;
    }
    assert.ok(containerId, `no container holds ${JSON.stringify(needle)}`);
    const text = textContentOf(document_.previewIndex.get(containerId));
    const startOffset = text.indexOf(needle);
    return {
        path,
        containerId,
        startOffset,
        endOffset: startOffset + needle.length,
        exact: needle,
        prefix: text.slice(Math.max(0, startOffset - 32), startOffset),
        suffix: text.slice(startOffset + needle.length, startOffset + needle.length + 32)
    };
}

/**
 * A deploy context wired to the real Lifecycle protect functions, with only the
 * sandbox frame and the wallet worker stubbed.
 */
async function protectHarness({ files = [stagedFile('index.html', SITE_HTML)] } = {}) {
    const dom = installDeployDom();
    const lifecycle = await import('../src/core/bootstrap/Lifecycle.js');
    const uploader = await import('../src/core/torrent/TorrentUploader.js');
    const wizard = await import('../src/ui/publish/DeployWizard.js');
    wizard.initDeployWizard();

    const sandboxes = [];
    const toasts = [];
    const context = {
        // The protect step, as it actually ships.
        enterProtectStep: lifecycle.enterProtectStep,
        exitProtectStep: lifecycle.exitProtectStep,
        finishProtectStep: lifecycle.finishProtectStep,
        handleProtectSelection: lifecycle.handleProtectSelection,
        commitPendingProtectSelection: lifecycle.commitPendingProtectSelection,
        removeProtectSelection: lifecycle.removeProtectSelection,
        addProtectRecipient: lifecycle.addProtectRecipient,
        removeProtectRecipient: lifecycle.removeProtectRecipient,
        selectionOverlapsExisting: lifecycle.selectionOverlapsExisting,
        renderProtectState: lifecycle.renderProtectState,
        resetProtectionState: lifecycle.resetProtectionState,
        teardownProtectPreview: lifecycle.teardownProtectPreview,
        bindProtectWorkspaceOnce: lifecycle.bindProtectWorkspaceOnce,
        readStagedDeployFiles: lifecycle.readStagedDeployFiles,
        collectStagedDeployFiles: lifecycle.collectStagedDeployFiles,
        refreshDeployUiState: lifecycle.refreshDeployUiState,
        invalidateSignedState: lifecycle.invalidateSignedState,
        clearDeploySession() {},
        getNormalizedDeployPath: uploader.getNormalizedDeployPath,
        getContentType: (path) => (path.endsWith('.js') ? 'text/javascript' : 'text/html'),

        // The frame is the one thing a Node test cannot run; everything the
        // step decides is exercised for real.
        renderProtectPreview(path) {
            sandboxes.push(path);
            this.protectActivePath = path;
        },

        pendingDeployFiles: files,
        protectSelections: [],
        protectRecipients: [],
        authController: {
            getActiveIdentity: () => ({
                address: OWNER_ADDRESS,
                chainId: 1,
                identityType: 'local-wallet',
                publicKey: OWNER_PUB,
                nostrPublicKey: '',
                npub: ''
            })
        },
        log() {},
        toast: {
            success: (message) => toasts.push({ level: 'success', message }),
            warning: (message) => toasts.push({ level: 'warning', message }),
            error: (message) => toasts.push({ level: 'error', message })
        }
    };

    return { dom, context, sandboxes, toasts };
}

// ─── 1. the step is genuinely optional ───────────────────────────────────

test('a publisher who protects nothing returns to the unchanged deploy flow', async () => {
    const { dom, context } = await protectHarness();

    await context.enterProtectStep();
    assert.equal(context.inProtectStep, true);
    assert.equal(dom.get('protect-workspace').classList.contains('hidden'), false);
    assert.equal(dom.get('deploy-panel-main').classList.contains('hidden'), true, 'the normal deploy UI is hidden');

    await context.finishProtectStep();

    assert.equal(context.inProtectStep, false);
    assert.equal(dom.get('protect-workspace').classList.contains('hidden'), true);
    assert.equal(dom.get('deploy-panel-main').classList.contains('hidden'), false, 'the normal deploy UI is back');
    assert.equal(context.protectedStagedFiles, null, 'nothing was rewritten');
    assert.equal(context.protectedSiteContext, null, 'and no protected-asset metadata was produced');

    // What signing will read is exactly the staged site.
    const staged = await context.collectStagedDeployFiles();
    assert.deepEqual(
        staged.map((file) => file.path),
        ['index.html']
    );
    assert.equal(new TextDecoder().decode(staged[0].bytes), SITE_HTML);
});

test('Back leaves the step without changing the staged site', async () => {
    const { dom, context } = await protectHarness();
    await context.enterProtectStep();

    const selection = context.handleProtectSelection(locatorFor(SITE_HTML, 'Secret text'));
    assert.equal(selection.status, 'ok');
    context.commitPendingProtectSelection();
    assert.equal(context.protectSelections.length, 1);

    context.exitProtectStep({ discard: true });

    assert.equal(context.protectSelections.length, 0, 'Back discards the pending choices');
    assert.equal(context.protectedStagedFiles, null);
    assert.equal(dom.get('deploy-panel-main').classList.contains('hidden'), false);
});

// ─── 2. selection → placeholder, through the step ────────────────────────

test('a resolved selection becomes an encrypted fragment and a placeholder', async () => {
    const { context } = await protectHarness();
    await context.enterProtectStep();

    assert.equal(context.handleProtectSelection(locatorFor(SITE_HTML, 'Secret text')).status, 'ok');
    context.commitPendingProtectSelection();
    await context.finishProtectStep();

    assert.equal(context.protectedSiteContext.protectedAssets.length, 1);
    const staged = await context.collectStagedDeployFiles();
    const html = new TextDecoder().decode(staged.find((file) => file.path === 'index.html').bytes);

    assert.ok(!html.includes('Secret text'), 'the plaintext is gone');
    assert.match(html, /<web25-protected data-asset-id="[0-9a-f-]{36}"><\/web25-protected>/);
    assert.ok(html.includes('Open text.'), 'the unprotected text is untouched');
    assert.ok(
        staged.some((file) => file.path.startsWith('.web25/protected/')),
        'the ciphertext ships as a bundle file'
    );
});

test('a selection that does not match the staged source is refused, not guessed', async () => {
    const { context } = await protectHarness();
    await context.enterProtectStep();

    const wrongText = { ...locatorFor(SITE_HTML, 'Secret text'), exact: 'Different text' };
    const result = context.handleProtectSelection(wrongText);
    assert.equal(result.status, 'rejected');
    assert.equal(context.protectPendingSelection, null);

    context.commitPendingProtectSelection();
    assert.equal(context.protectSelections.length, 0, 'a rejected selection cannot be committed');

    const unknownPage = { ...locatorFor(SITE_HTML, 'Secret text'), path: 'missing.html' };
    assert.equal(context.handleProtectSelection(unknownPage).status, 'rejected');
});

test('overlapping selections are refused while the publisher is still choosing', async () => {
    const { context } = await protectHarness();
    await context.enterProtectStep();

    assert.equal(context.handleProtectSelection(locatorFor(SITE_HTML, 'Open text. Secret')).status, 'ok');
    context.commitPendingProtectSelection();

    const overlapping = context.handleProtectSelection(locatorFor(SITE_HTML, 'Secret text'));
    assert.equal(overlapping.status, 'rejected');
    assert.match(overlapping.reason, /overlaps/);
    assert.equal(context.protectSelections.length, 1);
});

// ─── recipients ──────────────────────────────────────────────────────────

test('recipients are validated, deduplicated and shown with their EVM address', async () => {
    const { dom, context } = await protectHarness();
    await context.enterProtectStep();

    dom.get('protect-recipient-input').value = GUEST_PUB;
    context.addProtectRecipient();
    assert.equal(context.protectRecipients.length, 1);
    assert.equal(context.protectRecipients[0].address, ecies.evmAddressFromPublicKey(GUEST_PUB).toLowerCase());
    assert.equal(dom.get('protect-recipient-error').textContent, '');

    dom.get('protect-recipient-input').value = GUEST_PUB;
    context.addProtectRecipient();
    assert.equal(context.protectRecipients.length, 1, 'the same key is not added twice');
    assert.match(dom.get('protect-recipient-error').textContent, /already on the list/);

    dom.get('protect-recipient-input').value = OWNER_ADDRESS;
    context.addProtectRecipient();
    assert.equal(context.protectRecipients.length, 1);
    assert.match(dom.get('protect-recipient-error').textContent, /not encryption material/);

    dom.get('protect-recipient-input').value = `04${'11'.repeat(64)}`;
    context.addProtectRecipient();
    assert.match(dom.get('protect-recipient-error').textContent, /valid point/);
});

test('the owner is always authorised and has no way to be removed', async () => {
    const { dom, context } = await protectHarness();
    await context.enterProtectStep();

    dom.get('protect-recipient-input').value = GUEST_PUB;
    context.addProtectRecipient();
    assert.equal(context.handleProtectSelection(locatorFor(SITE_HTML, 'Secret text')).status, 'ok');
    context.commitPendingProtectSelection();

    // Removing every recipient the publisher added leaves the owner's grant.
    context.removeProtectRecipient(GUEST_PUB.toLowerCase());
    assert.deepEqual(context.protectRecipients, []);
    assert.deepEqual(context.protectSelections[0].recipientPublicKeys, []);

    await context.finishProtectStep();
    const grants = context.protectedSiteContext.protectedAssets[0].grants;
    assert.equal(grants.length, 1);
    assert.equal(grants[0].recipientPublicKey, OWNER_PUB.toLowerCase());
    assert.match(dom.get('protect-owner-row').textContent, /always authorised/);
});

test('a recipient added after a fragment was chosen still receives a grant', async () => {
    const { dom, context } = await protectHarness();
    await context.enterProtectStep();

    assert.equal(context.handleProtectSelection(locatorFor(SITE_HTML, 'Secret text')).status, 'ok');
    context.commitPendingProtectSelection();

    dom.get('protect-recipient-input').value = GUEST_PUB;
    context.addProtectRecipient();

    await context.finishProtectStep();
    const keys = context.protectedSiteContext.protectedAssets[0].grants.map((grant) => grant.recipientPublicKey);
    assert.deepEqual(keys.sort(), [OWNER_PUB.toLowerCase(), GUEST_PUB.toLowerCase()].sort());
});

test('a removed fragment is not encrypted', async () => {
    const { context } = await protectHarness();
    await context.enterProtectStep();

    assert.equal(context.handleProtectSelection(locatorFor(SITE_HTML, 'Secret text')).status, 'ok');
    context.commitPendingProtectSelection();
    context.removeProtectSelection(context.protectSelections[0].id);

    await context.finishProtectStep();
    assert.equal(context.protectedSiteContext, null);
    const staged = await context.collectStagedDeployFiles();
    assert.equal(new TextDecoder().decode(staged[0].bytes), SITE_HTML);
});

test('protecting requires an unlocked wallet, and says so', async () => {
    const { context } = await protectHarness();
    context.authController.getActiveIdentity = () => ({ address: OWNER_ADDRESS, chainId: 1, publicKey: null });
    await context.enterProtectStep();

    assert.equal(context.handleProtectSelection(locatorFor(SITE_HTML, 'Secret text')).status, 'ok');
    context.commitPendingProtectSelection();

    await assert.rejects(context.finishProtectStep(), /Unlock your wallet/);
});

// ─── the wizard reflects the step ────────────────────────────────────────

test('the wizard shows the protect step while it is open and what it did after', async () => {
    const { dom, context } = await protectHarness();

    await context.enterProtectStep();
    assert.deepEqual(dom.chipStates()[1], 'active');
    assert.equal(dom.chipNote(2), 'In progress');
    assert.match(dom.text('deploy-wizard-next'), /Select any text you want to protect/);

    assert.equal(context.handleProtectSelection(locatorFor(SITE_HTML, 'Secret text')).status, 'ok');
    context.commitPendingProtectSelection();
    await context.finishProtectStep();

    assert.equal(dom.chipNote(2), '1 protected');
    assert.match(dom.text('deploy-wizard-next'), /Sign your payload/);
});

// ─── staging a new artifact discards the old protection ──────────────────

test('staging a new artifact discards the previous protection choices', async () => {
    const { context } = await protectHarness();
    await context.enterProtectStep();
    assert.equal(context.handleProtectSelection(locatorFor(SITE_HTML, 'Secret text')).status, 'ok');
    context.commitPendingProtectSelection();
    await context.finishProtectStep();
    assert.ok(context.protectedStagedFiles);

    context.resetProtectionState();

    assert.deepEqual(context.protectSelections, []);
    assert.equal(context.protectedStagedFiles, null);
    assert.equal(context.protectedSiteContext, null);
    assert.equal(context.inProtectStep, false);
});

// ─── the markup the step drives ──────────────────────────────────────────

test('the protect workspace ships hidden, inside the deploy tab, with a sandboxed frame', () => {
    assert.match(MARKUP, /<section id="protect-workspace"[^>]*class="[^"]*hidden[^"]*"/);
    assert.match(MARKUP, /id="deploy-panel-main"/);

    const frame = MARKUP.match(/<iframe[\s\S]{0,400}?id="protect-preview-frame"[\s\S]{0,400}?>/);
    assert.ok(frame, 'the preview frame exists');
    assert.doesNotMatch(frame[0], /allow-same-origin/, 'the preview is never given the wallet origin');
    assert.match(frame[0], /sandbox="/, 'and it is never a plain unsandboxed iframe');

    for (const id of [
        'protect-file-select',
        'protect-fragment-list',
        'protect-recipient-input',
        'protect-recipient-list',
        'protect-owner-row',
        'protect-back-btn',
        'protect-next-btn'
    ]) {
        assert.ok(MARKUP.includes(`id="${id}"`), `${id} is part of the workspace`);
    }
});

// ─── the sandbox bridge, in both roles ───────────────────────────────────

test('the preview frame is created in authoring mode without a decrypt capability', () => {
    const iframe = { setAttribute() {}, removeAttribute() {}, contentWindow: {} };
    const sandbox = new SiteSandbox({
        iframe,
        hash: 'a'.repeat(40),
        entryFile: 'index.html',
        entryHtml: SITE_HTML,
        resolveFile: () => null,
        mode: 'authoring',
        onPreviewSelect: () => ({ status: 'ok' })
    });

    assert.equal(sandbox.mode, 'authoring');
    assert.equal(sandbox.onProtectedDecrypt, null, 'authoring has no decrypt handler at all');

    const html = buildSandboxBootstrapHtml({
        token: 'tok',
        parentOrigin: 'https://web25.cloud',
        prefix: '/peerweb-site/x/',
        mode: 'authoring',
        protectedEnabled: false
    });
    assert.match(html, /"mode":"authoring"/);
    assert.match(html, /"protectedEnabled":false/);
});

test('a viewed site never gets the authoring op, and an unprotected one gets neither', async () => {
    const replies = [];
    const port = {
        postMessage: (message) => replies.push(message),
        close() {},
        start() {},
        onmessage: null
    };

    const viewOnly = new SiteSandbox({
        iframe: { setAttribute() {}, removeAttribute() {}, contentWindow: {} },
        hash: 'a'.repeat(40),
        entryFile: 'index.html',
        entryHtml: SITE_HTML,
        resolveFile: () => null,
        onProtectedDecrypt: async (assetId) => ({ status: 'ok', assetId, html: 'plain' })
    });
    viewOnly.port = port;

    const assetId = newUuid();
    viewOnly._handle({ id: '1', op: SANDBOX_BRIDGE_OPS.PREVIEW_SELECT, selection: locatorFor(SITE_HTML, 'Secret text') });
    assert.deepEqual(replies.at(-1), { id: '1', ok: false, error: 'operation-not-allowed' });

    viewOnly._handle({ id: '2', op: SANDBOX_BRIDGE_OPS.PROTECTED_DECRYPT, assetId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(replies.at(-1), { id: '2', ok: true, result: { status: 'ok', assetId, html: 'plain' } });

    const unprotected = new SiteSandbox({
        iframe: { setAttribute() {}, removeAttribute() {}, contentWindow: {} },
        hash: 'a'.repeat(40),
        entryFile: 'index.html',
        entryHtml: SITE_HTML,
        resolveFile: () => null
    });
    unprotected.port = port;
    unprotected._handle({ id: '3', op: SANDBOX_BRIDGE_OPS.PROTECTED_DECRYPT, assetId });
    assert.deepEqual(replies.at(-1), { id: '3', ok: false, error: 'operation-not-allowed' });
});

test('protected.decrypt accepts an asset id and nothing else', () => {
    const assetId = newUuid();
    assert.deepEqual(validateBridgeRequest({ id: '1', op: 'protected.decrypt', assetId }), {
        id: '1',
        op: 'protected.decrypt',
        assetId
    });

    for (const bad of [undefined, '', 'not-a-uuid', '../../etc/passwd', assetId.slice(0, -1), 42, { assetId }]) {
        assert.throws(
            () => validateBridgeRequest({ id: '1', op: 'protected.decrypt', assetId: bad }),
            /asset id/,
            `${JSON.stringify(bad)} must be refused`
        );
    }

    // Nothing else the frame sends survives validation.
    const extra = validateBridgeRequest({
        id: '1',
        op: 'protected.decrypt',
        assetId,
        siteId: 'other-site',
        wrappedKey: 'ff'.repeat(120),
        ciphertext: 'anything'
    });
    assert.deepEqual(Object.keys(extra).sort(), ['assetId', 'id', 'op']);
});

test('preview.select is bounded and typed before the application looks at it', () => {
    const selection = locatorFor(SITE_HTML, 'Secret text');
    const accepted = validateBridgeRequest({ id: '1', op: 'preview.select', selection });
    assert.equal(accepted.selection.exact, 'Secret text');
    assert.equal(accepted.selection.path, 'index.html');

    const rejected = [
        undefined,
        { ...selection, containerId: 'not-a-node-id' },
        { ...selection, exact: '' },
        { ...selection, startOffset: 10, endOffset: 5 },
        { ...selection, startOffset: -1 },
        { ...selection, path: '../../../etc/passwd' },
        { ...selection, path: '' }
    ];
    for (const bad of rejected) {
        assert.throws(
            () => validateBridgeRequest({ id: '1', op: 'preview.select', selection: bad }),
            /preview\.select|resource\.get/,
            `${JSON.stringify(bad)?.slice(0, 60)} must be refused`
        );
    }

    // Context strings are clipped rather than trusted at any length.
    const huge = validateBridgeRequest({
        id: '1',
        op: 'preview.select',
        selection: { ...selection, prefix: 'x'.repeat(5000), suffix: 'y'.repeat(5000) }
    });
    assert.equal(huge.selection.prefix.length, 256);
    assert.equal(huge.selection.suffix.length, 256);
});
