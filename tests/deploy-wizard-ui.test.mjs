import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installDeployDom } from './helpers/fake-deploy-dom.mjs';
import { parseWeb25Address } from '../src/gofile/Web25Url.js';
import { GoFileService } from '../src/gofile/GoFileService.js';
import { gofileMirrorFilename } from '../src/gofile/GoFileMirrorCodec.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const LOCATOR = 'mirrorContentId9';
const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function payloadFile(path, text) {
    const bytes = new TextEncoder().encode(text);
    return {
        path,
        name: path,
        type: 'application/json',
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
}

/**
 * A deploy context wired to the real UI modules, with only the network and the
 * torrent seeding stubbed out.
 */
async function deployHarness({ mirrorEnabled = false, gofileService = null } = {}) {
    const dom = installDeployDom();
    dom.get('deploy-gofile-mirror').checked = mirrorEnabled;

    const lifecycle = await import('../src/core/bootstrap/Lifecycle.js');
    const uploader = await import('../src/core/torrent/TorrentUploader.js');
    const wizard = await import('../src/ui/publish/DeployWizard.js');
    wizard.initDeployWizard();

    // Mirroring now verifies its own upload by reading it back publicly, so a
    // stub that only uploads is not a working GoFile. Echo the uploaded bytes
    // unless a test deliberately supplies its own read.
    const service = gofileService
        ? {
              ...gofileService,
              upload: async (blob, options) => {
                  service.uploaded = blob;
                  return gofileService.upload(blob, options);
              },
              downloadPublicMirror:
                  gofileService.downloadPublicMirror ||
                  (async () => new Uint8Array(await service.uploaded.arrayBuffer()))
          }
        : null;

    const toasts = [];
    const recorded = [];
    const context = {
        deploySignedArtifact: lifecycle.deploySignedArtifact,
        renderDeployedArtifact: lifecycle.renderDeployedArtifact,
        createGoFileMirror: lifecycle.createGoFileMirror,
        isGoFileMirrorRequested: lifecycle.isGoFileMirrorRequested,
        completeDeployment: lifecycle.completeDeployment,
        resetDeployPipeline: lifecycle.resetDeployPipeline,
        refreshPagesPanel: async () => {},
        clearDeploySession() {},
        // The deploy page hands a finished deployment to Pages and clears
        // itself, so what it recorded is where the result now lives.
        recordSeedingSession: async (params) => {
            recorded.push(params);
        },
        refreshDeployUiState: lifecycle.refreshDeployUiState,
        setupQuickUpload: uploader.setupQuickUpload,
        sanitizeHash: (value) => `${value}`.replace(/[^a-fA-F0-9]/g, '').toLowerCase(),
        createTrackedObjectURL: () => 'blob:stub',
        updateSeedingStats() {},
        persistDeploySession() {},
        log() {},
        toast: {
            warning: (message, title) => toasts.push({ level: 'warning', message, title }),
            success: (message, title) => toasts.push({ level: 'success', message, title }),
            info: (message, title) => toasts.push({ level: 'info', message, title })
        },
        authController: { getActiveIdentity: () => ({ address: '0xpublisher', chainId: 1 }) },
        pendingDeployFiles: [payloadFile('index.html', '<h1>site</h1>')],
        lastSignature: { signature: `0x${'ab'.repeat(32)}`, signatureAlgorithm: 'EVM_SECP256K1', signedAt: 'now' },
        lastSignedPublish: { torrentHash: HASH },
        lastPublishCandidate: {
            hash: HASH,
            siteName: 'site',
            torrent: { name: 'site' },
            signedTorrentFile: new Uint8Array([1, 2, 3]),
            payloadFiles: [payloadFile('.torrentchain', '{"signed":true}')]
        },
        gofileService: service,
        gofileCredentialStore: { read: async () => null, write: async () => {}, clearInvalidToken: async () => {} }
    };
    context.setupQuickUpload();
    return { dom, context, toasts, recorded, deployUrl: () => recorded.at(-1)?.deploy?.url };
}

const progress = (dom) => ({
    percent: Number(dom.get('upload-progress-bar').getAttribute('aria-valuenow')),
    width: dom.get('upload-progress-bar').style.width,
    label: dom.text('upload-progress-text'),
    state: dom
        .get('upload-progress')
        .classList.values()
        .find((name) => name.startsWith('progress-'))
});

const stage = (dom) => ({ label: dom.text('deploy-stage-label'), detail: dom.text('deploy-stage-detail') });

// ── 1. Markup: the stepper the wizard drives ────────────────────────────────

test('the deploy stepper ships all seven steps in order', () => {
    const chips = [...MARKUP.matchAll(/<span class="step-chip-text">([^<]+)<\/span\s*>/g)].map((match) => match[1]);
    assert.deepEqual(chips, [
        '1. Select files',
        '2. Build in-memory bundle',
        '3. Review payload',
        '4. Sign payload',
        '5. Deploy signed memory torrent',
        '6. Create GoFile mirror',
        '7. Live + mirrored'
    ]);
    assert.match(MARKUP, /id="step-chip-mirror"/);
    assert.match(MARKUP, /<span class="step-chip-note">Optional<\/span>/);
});

test('the mirror opt-in ships off, labelled, described, and clearly optional', () => {
    const checkbox = MARKUP.match(/<input\s+type="checkbox"\s+id="deploy-gofile-mirror"[^>]*\/?>/s);
    assert.ok(checkbox, 'the opt-in exists');
    assert.doesNotMatch(checkbox[0], /\bchecked\b/, 'it is off until the publisher asks for it');
    assert.match(checkbox[0], /aria-describedby="deploy-gofile-mirror-hint"/);
    assert.match(MARKUP, /<label class="deploy-option-label" for="deploy-gofile-mirror">/);
    assert.match(MARKUP, /Create temporary GoFile fallback mirror/);
    assert.match(MARKUP, /Optional\. Uploads a copy of this signed deployment to GoFile\./);
    assert.match(MARKUP, /WebTorrent remains the\s+primary transport/);
});

test('progress and status regions carry the semantics assistive tech needs', () => {
    assert.match(MARKUP, /id="upload-progress-bar"[^>]*/s);
    const bar = MARKUP.slice(MARKUP.indexOf('id="upload-progress-bar"'));
    assert.match(bar.slice(0, 400), /role="progressbar"/);
    assert.match(bar.slice(0, 400), /aria-valuemin="0"/);
    assert.match(bar.slice(0, 400), /aria-valuemax="100"/);
    assert.match(MARKUP, /id="upload-progress-text"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(MARKUP, /<div class="deploy-stage-box" role="status" aria-live="polite">/);
    assert.match(MARKUP, /id="hash-input"[\s\S]{0,300}aria-label="Torrent hash, hash and mirror locator/);
});

test('the resolver input documents and accepts all three address forms', () => {
    // The help text used to promise that only a bare hash was accepted.
    assert.doesNotMatch(MARKUP, /Just the hash/);
    assert.match(MARKUP, /placeholder="Paste a torrent hash, hash&amp;mirror, or WEB25 URL/);
    // Each accepted form is named on the gateway itself, beside the field,
    // rather than only inside the placeholder.
    assert.match(MARKUP, /<b>hash<\/b> 40-character infohash/);
    assert.match(MARKUP, /<b>hash&amp;locator<\/b> hash with GoFile mirror/);
    assert.match(MARKUP, /<b>web25 url<\/b> a complete shared link/);

    for (const input of [HASH, `${HASH}&${LOCATOR}`, `https://web25.cloud/?orc=${HASH}&${LOCATOR}`]) {
        const parsed = parseWeb25Address(input);
        assert.equal(parsed.torrentHash, HASH);
        assert.equal(parsed.gofileLocator, input === HASH ? null : LOCATOR);
    }
});

// ── 1b. Wizard screens ──────────────────────────────────────────────────────

test('the wizard shows one screen per stage, ending on the shareable result', async () => {
    const { dom, context } = await deployHarness();

    context.pendingDeployFiles = [];
    context.lastSignature = null;
    context.lastSignedPublish = null;
    context.refreshDeployUiState();
    assert.equal(dom.activeScreen(), 'upload');

    context.pendingDeployFiles = [payloadFile('index.html', 'x')];
    context.refreshDeployUiState();
    assert.equal(dom.activeScreen(), 'sign');

    // Signing does not move the publisher: Deploy is the next button on the
    // same screen.
    context.lastSignature = { signature: '0xsig' };
    context.lastSignedPublish = { torrentHash: HASH };
    context.refreshDeployUiState();
    assert.equal(dom.activeScreen(), 'sign');

    context.lastDeployResult = { hash: HASH, mirrorState: 'disabled' };
    context.refreshDeployUiState();
    assert.equal(dom.activeScreen(), 'live');

    // Whatever is off-screen is out of the tab order too.
    const hidden = dom.screens.filter((screen) => !screen.classList.contains('is-active'));
    assert.equal(hidden.length, 2);
    hidden.forEach((screen) => assert.equal(screen.getAttribute('inert'), ''));
});

test('stepping back to the drop zone keeps deploy state and yields when the pipeline moves on', async () => {
    const { dom, context } = await deployHarness();

    context.pendingDeployFiles = [payloadFile('index.html', 'x')];
    context.lastSignature = { signature: '0xsig' };
    context.lastSignedPublish = { torrentHash: HASH };
    context.refreshDeployUiState();
    assert.equal(dom.activeScreen(), 'sign');

    dom.pressDeployNav();
    assert.equal(dom.activeScreen(), 'upload');

    // Looking back at the drop zone is presentation only: the staged files and
    // the signature that let Deploy run are still there.
    context.refreshDeployUiState();
    assert.equal(dom.activeScreen(), 'upload');
    assert.equal(dom.get('sign-publish-btn').disabled, false);
    assert.equal(dom.get('publish-btn').disabled, false);

    // The pipeline itself moving on overrides where the publisher wandered.
    context.lastDeployResult = { hash: HASH, mirrorState: 'disabled' };
    context.refreshDeployUiState();
    assert.equal(dom.activeScreen(), 'live');
});

// ── 2. Wizard state, before deployment ──────────────────────────────────────

test('the wizard walks 1 → 4 → 5 and never presents the mirror step as required', async () => {
    const { dom, context } = await deployHarness();

    context.pendingDeployFiles = [];
    context.lastSignature = null;
    context.lastSignedPublish = null;
    context.refreshDeployUiState();
    assert.deepEqual(dom.chipStates(), ['active', 'locked', 'locked', 'locked', 'locked', 'locked', 'locked']);
    assert.equal(dom.get('sign-publish-btn').disabled, true);
    assert.equal(dom.get('publish-btn').disabled, true);

    context.pendingDeployFiles = [payloadFile('index.html', 'x')];
    context.refreshDeployUiState();
    assert.deepEqual(dom.chipStates(), ['done', 'done', 'done', 'active', 'locked', 'locked', 'locked']);
    assert.equal(dom.get('sign-publish-btn').disabled, false);
    assert.equal(dom.get('publish-btn').disabled, true);

    context.lastSignature = { signature: '0xsig' };
    context.lastSignedPublish = { torrentHash: HASH };
    context.refreshDeployUiState();
    assert.deepEqual(dom.chipStates(), ['done', 'done', 'done', 'done', 'active', 'locked', 'locked']);
    assert.equal(dom.get('publish-btn').disabled, false);
    assert.equal(dom.chipNote(6), 'Optional', 'the mirror step reads as optional before it is reached');

    // The lit "current" marker follows the active step instead of staying on
    // step 1, which would render a completed step as the current one too.
    const current = dom.chips.map((chip, index) => (chip.classList.contains('is-current') ? index + 1 : null));
    assert.deepEqual(current.filter(Boolean), [5]);
    assert.deepEqual(
        dom.chips.map((chip) => chip.getAttribute('aria-current')).filter(Boolean),
        ['step'],
        'exactly one step is announced as current'
    );
});

// ── 3. What a finished deployment leaves behind ─────────────────────────────
//
// It used to leave a result panel: a link, a mirror row, identity rows, and a
// "Deploy another site" button to dismiss it with. All of that is now a card in
// Pages, which is where the site can also be opened, copied, and stopped. So
// what these pin is the hand-off — the record the deploy page passes on — and
// that the page itself goes back to being ready for the next deployment.

/** The deploy page as somebody arriving at it would find it. */
const isReadyForNextDeploy = (dom, context) => ({
    stage: stage(dom).label,
    screen: dom.activeScreen(),
    step: dom.chipStates().indexOf('active') + 1,
    files: context.pendingDeployFiles,
    signature: context.lastSignature,
    deployResult: context.lastDeployResult,
    resultHidden: dom.get('upload-result').classList.contains('hidden')
});

test('a WebTorrent-only deployment skips the mirror and hands the site to Pages', async () => {
    let contacted = 0;
    const { dom, context, toasts, recorded } = await deployHarness({
        mirrorEnabled: false,
        gofileService: {
            upload: async () => {
                contacted += 1;
                return { mirrorLocator: LOCATOR };
            }
        }
    });

    await context.deploySignedArtifact();

    assert.equal(contacted, 0, 'GoFile is never contacted');
    assert.equal(recorded.length, 1, 'the deployment is handed over exactly once');
    assert.equal(recorded.at(-1).deploy.url, `https://web25.cloud/?orc=${HASH}`);
    assert.equal(recorded.at(-1).deploy.mirrorState, 'disabled');
    assert.equal(recorded.at(-1).deploy.mirror, null);
    assert.equal(
        toasts.filter((toast) => toast.level === 'warning').length,
        0,
        'a mirror nobody asked for is never reported as a failure'
    );
});

test('a mirrored deployment publishes the locator with the link', async () => {
    const { context, toasts, recorded } = await deployHarness({
        mirrorEnabled: true,
        gofileService: { upload: async () => ({ mirrorLocator: LOCATOR }) }
    });

    await context.deploySignedArtifact();

    assert.equal(recorded.at(-1).deploy.url, `https://web25.cloud/?orc=${HASH}&${LOCATOR}`);
    assert.equal(recorded.at(-1).deploy.mirror.locator, LOCATOR);
    assert.equal(recorded.at(-1).deploy.mirrorState, 'available');
    assert.equal(toasts.at(-1).level, 'success');
});

test('the site is recorded as live before the mirror is even attempted', async () => {
    let whileUploading = null;
    const { dom, context, recorded } = await deployHarness({
        mirrorEnabled: true,
        gofileService: {
            upload: async () => {
                // Mid-deployment: the torrent is already seeding, so the record
                // and the progress line must both say so rather than implying
                // the deployment is still pending on an optional step.
                whileUploading = {
                    mirrorState: recorded.at(-1)?.deploy?.mirrorState,
                    url: recorded.at(-1)?.deploy?.url,
                    label: dom.text('upload-progress-text'),
                    stage: stage(dom).label
                };
                return { mirrorLocator: LOCATOR };
            }
        }
    });

    await context.deploySignedArtifact();

    assert.equal(whileUploading.mirrorState, 'pending');
    assert.equal(whileUploading.url, `https://web25.cloud/?orc=${HASH}`);
    assert.match(whileUploading.label, /site live/i);
    assert.equal(whileUploading.stage, 'Site live');
});

test('a mirror that never arrives still leaves a successful deployment', async () => {
    const { context, toasts, recorded } = await deployHarness({ mirrorEnabled: true });
    // A GoFile that accepts the connection and then says nothing: the service's
    // own deadline is what ends it, not the deployment waiting.
    context.gofileService = new GoFileService({
        fetchImpl: (_endpoint, init) =>
            new Promise((_resolve, reject) => {
                const socket = setTimeout(() => {}, 10000);
                init.signal.addEventListener('abort', () => {
                    clearTimeout(socket);
                    reject(init.signal.reason);
                });
            }),
        uploadTimeoutMs: 25
    });

    await context.deploySignedArtifact();

    assert.equal(recorded.at(-1).deploy.url, `https://web25.cloud/?orc=${HASH}`, 'the torrent-only link is published');
    assert.equal(recorded.at(-1).deploy.mirrorState, 'unavailable');
    const warnings = toasts.filter((toast) => toast.level === 'warning');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /deployed successfully/i);
});

test('the identity and signature travel with the deployment', async () => {
    const { context, recorded } = await deployHarness({ mirrorEnabled: false });

    await context.deploySignedArtifact();

    const { deploy } = recorded.at(-1);
    assert.equal(deploy.signedBy, '0xpublisher');
    assert.equal(deploy.signature, `0x${'ab'.repeat(32)}`);
    assert.equal(deploy.signatureAlgorithm, 'EVM_SECP256K1');
    assert.equal(deploy.signatureStatus, 'VERIFIED');
});

test('every deployment path leaves the page ready for the next one', async () => {
    for (const scenario of [
        { name: 'torrent only', mirrorEnabled: false, gofileService: null },
        {
            name: 'mirrored',
            mirrorEnabled: true,
            gofileService: { upload: async () => ({ mirrorLocator: LOCATOR }) }
        },
        {
            name: 'mirror failed',
            mirrorEnabled: true,
            gofileService: {
                upload: async () => {
                    throw new Error('nope');
                }
            }
        }
    ]) {
        const { dom, context } = await deployHarness(scenario);

        await context.deploySignedArtifact();

        assert.deepEqual(
            isReadyForNextDeploy(dom, context),
            {
                stage: 'Stage 1 · Select files',
                screen: 'upload',
                step: 1,
                files: null,
                signature: null,
                deployResult: null,
                resultHidden: true
            },
            `${scenario.name}: the deploy page goes back to the start`
        );
        // Nothing half-finished is left running on screen either.
        assert.equal(dom.get('upload-progress').classList.contains('hidden'), true);
    }
});
