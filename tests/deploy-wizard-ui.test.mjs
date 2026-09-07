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

    const toasts = [];
    const context = {
        deploySignedArtifact: lifecycle.deploySignedArtifact,
        renderDeployedArtifact: lifecycle.renderDeployedArtifact,
        createGoFileMirror: lifecycle.createGoFileMirror,
        isGoFileMirrorRequested: lifecycle.isGoFileMirrorRequested,
        renderDeploymentSummary: lifecycle.renderDeploymentSummary,
        refreshDeployUiState: lifecycle.refreshDeployUiState,
        showUploadResult: uploader.showUploadResult,
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
        gofileService,
        gofileCredentialStore: { read: async () => null, write: async () => {}, clearInvalidToken: async () => {} }
    };
    context.setupQuickUpload();
    return { dom, context, toasts };
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
    assert.match(MARKUP, /Enter a hash, <code>hash&amp;GoFileLocator<\/code>, or a complete WEB25 URL/);
    assert.match(MARKUP, /placeholder="Torrent hash, hash&amp;mirror, or WEB25 URL/);

    for (const input of [HASH, `${HASH}&${LOCATOR}`, `https://web25.cloud/?orc=${HASH}&${LOCATOR}`]) {
        const parsed = parseWeb25Address(input);
        assert.equal(parsed.torrentHash, HASH);
        assert.equal(parsed.gofileLocator, input === HASH ? null : LOCATOR);
    }
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

// ── 3. WebTorrent-only deployment ───────────────────────────────────────────

test('a WebTorrent-only deployment skips the mirror step and finishes at 100%', async () => {
    let contacted = 0;
    const { dom, context, toasts } = await deployHarness({
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
    assert.deepEqual(dom.chipStates(), ['done', 'done', 'done', 'done', 'done', 'skipped', 'active']);
    assert.equal(dom.chipNote(6), 'Skipped');
    assert.equal(dom.chipText(7), '7. Live and seeding', 'the final step does not claim a mirror that was never made');
    assert.deepEqual(progress(dom), {
        percent: 100,
        width: '100%',
        label: 'Live and seeding',
        state: 'progress-success'
    });
    assert.deepEqual(stage(dom), { label: 'Deployment complete', detail: 'Live and seeding from memory' });
    assert.equal(dom.text('result-transport'), 'Live and seeding over WebTorrent');
    assert.equal(dom.get('result-gofile-row').classList.contains('hidden'), true, 'no empty mirror row');
    assert.equal(dom.text('result-url'), `https://web25.cloud/?orc=${HASH}`);
    assert.equal(dom.get('upload-result').classList.contains('hidden'), false);
    assert.match(dom.text('deploy-wizard-next'), /live and seeding/i);
    assert.equal(
        toasts.filter((toast) => toast.level === 'warning').length,
        0,
        'a mirror nobody asked for is never reported as a failure'
    );
});

// ── 4. Mirrored deployment ──────────────────────────────────────────────────

test('a mirrored deployment moves through step 6 and lands on Live + mirrored', async () => {
    const seen = [];
    const { dom, context, toasts } = await deployHarness({
        mirrorEnabled: true,
        gofileService: {
            upload: async (_blob, options) => {
                // Observed mid-flight: the torrent result is already published.
                seen.push({
                    chips: dom.chipStates(),
                    progress: progress(dom),
                    stage: stage(dom),
                    url: dom.text('result-url'),
                    resultVisible: !dom.get('upload-result').classList.contains('hidden'),
                    mirrorRow: dom.text('result-gofile-mirror')
                });
                return { mirrorLocator: LOCATOR, filename: options.filename };
            }
        }
    });

    await context.deploySignedArtifact();

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].chips, ['done', 'done', 'done', 'done', 'done', 'active', 'locked']);
    assert.equal(seen[0].progress.percent, 90);
    assert.equal(seen[0].progress.label, 'Site live. Creating optional GoFile fallback mirror…');
    assert.equal(seen[0].progress.state, 'progress-running');
    assert.deepEqual(seen[0].stage, {
        label: 'Site live',
        detail: 'Deployed over WebTorrent. Creating the optional GoFile fallback mirror…'
    });
    assert.equal(seen[0].resultVisible, true, 'the successful torrent result is already on screen');
    assert.equal(seen[0].url, `https://web25.cloud/?orc=${HASH}`);
    assert.equal(seen[0].mirrorRow, 'Creating…');

    assert.deepEqual(dom.chipStates(), ['done', 'done', 'done', 'done', 'done', 'done', 'active']);
    assert.equal(dom.chipNote(6), 'Created');
    assert.equal(dom.chipText(7), '7. Live + mirrored');
    assert.deepEqual(progress(dom), {
        percent: 100,
        width: '100%',
        label: 'Live + temporary mirror',
        state: 'progress-success'
    });
    assert.deepEqual(stage(dom), { label: 'Deployment complete', detail: 'Live, seeding, and temporarily mirrored' });
    assert.equal(dom.get('result-gofile-row').classList.contains('hidden'), false);
    assert.equal(dom.text('result-gofile-mirror'), LOCATOR);
    assert.equal(dom.text('result-url'), `https://web25.cloud/?orc=${HASH}&${LOCATOR}`);
    assert.equal(dom.text('result-transport'), 'Live and seeding over WebTorrent · GoFile fallback mirror available');
    assert.equal(toasts.at(-1).level, 'success');
});

test('Copy Link and Open Site use exactly the URL the panel shows', async () => {
    const { dom, context } = await deployHarness({
        mirrorEnabled: true,
        gofileService: { upload: async () => ({ mirrorLocator: LOCATOR }) }
    });
    await context.deploySignedArtifact();

    const shown = dom.text('result-url');
    dom.get('open-site').dispatch('click');
    dom.get('copy-link').dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(shown, `https://web25.cloud/?orc=${HASH}&${LOCATOR}`);
    assert.deepEqual(dom.opened, [shown]);
    assert.deepEqual(dom.copied, [shown]);
});

// ── 5. Slow mirror ──────────────────────────────────────────────────────────

test('a slow mirror never implies the deployment itself is still pending', async () => {
    let release;
    const pending = new Promise((resolve) => {
        release = resolve;
    });
    const { dom, context } = await deployHarness({
        mirrorEnabled: true,
        gofileService: { upload: () => pending.then(() => ({ mirrorLocator: LOCATOR })) }
    });

    const deploying = context.deploySignedArtifact();
    await new Promise((resolve) => setImmediate(resolve));

    // While the mirror is in flight the site is already live and shareable.
    assert.equal(dom.get('upload-result').classList.contains('hidden'), false);
    assert.equal(dom.text('result-url'), `https://web25.cloud/?orc=${HASH}`);
    assert.equal(dom.text('result-transport'), 'Live and seeding over WebTorrent · creating optional mirror');
    assert.equal(stage(dom).label, 'Site live');
    assert.notEqual(stage(dom).label, 'Deploying');
    assert.match(dom.text('deploy-wizard-next'), /live and seeding/i);
    assert.match(dom.text('deploy-wizard-next'), /optional fallback mirror/i);
    assert.equal(dom.get('publish-btn').disabled, false, 'the interface stays usable');
    assert.deepEqual(dom.chipStates(), ['done', 'done', 'done', 'done', 'done', 'active', 'locked']);
    assert.equal(dom.chipNote(6), 'In progress');

    release();
    await deploying;
    assert.equal(progress(dom).percent, 100);
});

// ── 6. Mirror timeout and failure ───────────────────────────────────────────

test('a mirror timeout leaves a successful, complete, torrent-only deployment', async () => {
    const { dom, context, toasts } = await deployHarness({ mirrorEnabled: true });
    context.gofileService = new GoFileService({
        fetchImpl: (_url, init) =>
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

    assert.deepEqual(dom.chipStates(), ['done', 'done', 'done', 'done', 'done', 'failed', 'active']);
    assert.equal(dom.chipNote(6), 'Not created');
    assert.equal(dom.chipText(7), '7. Live and seeding');
    assert.deepEqual(progress(dom), {
        percent: 100,
        width: '100%',
        label: 'Live and seeding (no fallback mirror)',
        state: 'progress-success'
    });
    assert.deepEqual(stage(dom), {
        label: 'Deployment complete',
        detail: 'Live and seeding. The optional GoFile fallback mirror could not be created.'
    });
    assert.equal(dom.text('result-url'), `https://web25.cloud/?orc=${HASH}`);
    assert.equal(dom.text('result-gofile-mirror'), 'Not created — WebTorrent only');
    assert.equal(dom.get('result-gofile-row').classList.contains('hidden'), false, 'the optional state is explained');
    assert.equal(dom.text('result-transport'), 'Live and seeding over WebTorrent · no fallback mirror');

    const warning = toasts.find((toast) => toast.level === 'warning');
    assert.match(warning.message, /Site deployed successfully/);
    assert.match(warning.message, /could not be created/);
    assert.match(warning.message, /timed out/);
    assert.match(JSON.parse(dom.text('publish-output')).temporaryMirror.error, /timed out/);
    assert.equal(JSON.parse(dom.text('publish-output')).deploymentStatus, 'completed');
});

test('Copy Link and Open Site fall back to the torrent-only URL after a mirror failure', async () => {
    const { dom, context } = await deployHarness({
        mirrorEnabled: true,
        gofileService: {
            upload: async () => {
                throw new Error('GoFile rejected the upload.');
            }
        }
    });
    await context.deploySignedArtifact();

    dom.get('open-site').dispatch('click');
    dom.get('copy-link').dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(dom.opened, [`https://web25.cloud/?orc=${HASH}`]);
    assert.deepEqual(dom.copied, [`https://web25.cloud/?orc=${HASH}`]);
});

// ── 7. Result panel content ─────────────────────────────────────────────────

test('the result panel never renders an empty or null-looking mirror value', async () => {
    for (const [enabled, service, expected] of [
        [false, null, null],
        [true, { upload: async () => ({ mirrorLocator: LOCATOR }) }, LOCATOR],
        [
            true,
            {
                upload: async () => {
                    throw new Error('nope');
                }
            },
            'Not created — WebTorrent only'
        ]
    ]) {
        const { dom, context } = await deployHarness({ mirrorEnabled: enabled, gofileService: service });
        await context.deploySignedArtifact();
        const hidden = dom.get('result-gofile-row').classList.contains('hidden');
        const shown = dom.text('result-gofile-mirror');
        assert.doesNotMatch(shown, /^(null|undefined|)$/, 'the mirror row is never empty or null');
        if (expected === null) assert.equal(hidden, true);
        else {
            assert.equal(hidden, false);
            assert.equal(shown, expected);
        }
        dom.restore();
    }
});

test('every deployment fills the identity and signature rows', async () => {
    const { dom, context } = await deployHarness();
    await context.deploySignedArtifact();

    assert.equal(dom.text('result-hash'), HASH);
    assert.equal(dom.text('result-signed-by'), '0xpublisher');
    assert.equal(dom.text('result-signature-preview'), `0x${'ab'.repeat(32)}`.slice(0, 24) + '...');
    assert.equal(dom.text('result-signature-status'), 'VERIFIED');
});

// ── 8. No loading state outlives its promise ────────────────────────────────

test('no deployment path leaves a running progress state behind', async () => {
    const services = [
        [false, null],
        [true, { upload: async () => ({ mirrorLocator: LOCATOR, filename: gofileMirrorFilename(HASH) }) }],
        [
            true,
            {
                upload: async () => {
                    throw new Error('mirror refused');
                }
            }
        ]
    ];
    for (const [enabled, service] of services) {
        const { dom, context } = await deployHarness({ mirrorEnabled: enabled, gofileService: service });
        await context.deploySignedArtifact();
        const final = progress(dom);
        assert.equal(final.state, 'progress-success', 'a settled deployment is never left running');
        assert.equal(final.percent, 100);
        assert.equal(stage(dom).label, 'Deployment complete');
        dom.restore();
    }
});
