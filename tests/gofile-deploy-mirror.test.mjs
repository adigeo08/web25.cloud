import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GoFileService } from '../src/gofile/GoFileService.js';
import { gofileMirrorFilename } from '../src/gofile/GoFileMirrorCodec.js';

const HASH_ONE = '0123456789abcdef0123456789abcdef01234567';
const HASH_TWO = 'fedcba9876543210fedcba9876543210fedcba98';

function stubElement(extra = {}) {
    return {
        textContent: '',
        href: '',
        download: '',
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        removeAttribute() {},
        ...extra
    };
}

function installDom() {
    const elements = new Map();
    globalThis.window = {
        location: {
            origin: 'https://web25.cloud',
            pathname: '/',
            href: 'https://web25.cloud/',
            hostname: 'web25.cloud',
            protocol: 'https:',
            search: ''
        },
        addEventListener() {}
    };
    Object.defineProperty(globalThis, 'location', {
        value: globalThis.window.location,
        configurable: true,
        writable: true
    });
    globalThis.document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, stubElement());
            return elements.get(id);
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {}
    };
    return elements;
}

function payloadFile(path, text) {
    const bytes = new TextEncoder().encode(text);
    return {
        path,
        name: path,
        type: 'application/json',
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
}

/** A deploy context whose torrent half is already done and seeding. */
async function deployContext({ hash = HASH_ONE, mirrorEnabled = false, gofileService = null } = {}) {
    const elements = installDom();
    elements.set('deploy-gofile-mirror', stubElement({ checked: mirrorEnabled }));

    const lifecycle = await import('../src/core/bootstrap/Lifecycle.js');
    const uploader = await import('../src/core/torrent/TorrentUploader.js');

    const warnings = [];
    const wrappedGoFileService = gofileService
        ? {
              ...gofileService,
              upload: async (blob, options) => {
                  wrappedGoFileService.lastUpload = blob;
                  return gofileService.upload(blob, options);
              },
              downloadPublicMirror:
                  gofileService.downloadPublicMirror ||
                  (async () => new Uint8Array(await wrappedGoFileService.lastUpload.arrayBuffer()))
          }
        : null;
    const context = {
        deploySignedArtifact: lifecycle.deploySignedArtifact,
        renderDeployedArtifact: lifecycle.renderDeployedArtifact,
        createGoFileMirror: lifecycle.createGoFileMirror,
        isGoFileMirrorRequested: lifecycle.isGoFileMirrorRequested,
        renderDeploymentSummary: lifecycle.renderDeploymentSummary,
        refreshDeployUiState: lifecycle.refreshDeployUiState,
        showUploadResult: uploader.showUploadResult,
        sanitizeHash: (value) => `${value}`.replace(/[^a-fA-F0-9]/g, '').toLowerCase(),
        createTrackedObjectURL: () => 'blob:stub',
        updateSeedingStats() {},
        persistDeploySession() {},
        log() {},
        toast: { warning: (message) => warnings.push(message), success() {}, info() {} },
        authController: { getActiveIdentity: () => ({ address: '0xpublisher', chainId: 1 }) },
        lastSignature: { signature: '0xsignature', signatureAlgorithm: 'EVM_SECP256K1', signedAt: 'now' },
        lastSignedPublish: { torrentHash: hash },
        lastPublishCandidate: {
            hash,
            siteName: 'site',
            torrent: { name: 'site' },
            signedTorrentFile: new Uint8Array([1, 2, 3]),
            payloadFiles: [payloadFile('.torrentchain', '{"signed":true}')]
        },
        gofileService: wrappedGoFileService,
        gofileCredentialStore: {
            read: async () => null,
            write: async () => {},
            clearInvalidToken: async () => {}
        }
    };
    return { context, elements, warnings, url: () => elements.get('result-url')?.textContent };
}

test('the deploy wizard ships the mirror checkbox unchecked', () => {
    const markup = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const checkbox = markup.match(/<input[^>]*id="deploy-gofile-mirror"[^>]*>/);
    assert.ok(checkbox, 'the deploy wizard offers a GoFile mirror opt-in');
    assert.doesNotMatch(checkbox[0], /\bchecked\b/, 'the opt-in is off until the publisher asks for it');
});

test('an unchecked opt-in never touches GoFile and yields a plain ?orc= link', async () => {
    let contacted = 0;
    const { context, url } = await deployContext({
        mirrorEnabled: false,
        gofileService: {
            upload: async () => {
                contacted += 1;
                return { mirrorLocator: 'file_1' };
            }
        }
    });

    await context.deploySignedArtifact();

    assert.equal(contacted, 0, 'GoFile is never contacted for a P2P-only deployment');
    assert.equal(url(), `https://web25.cloud/?orc=${HASH_ONE}`);
    assert.equal(context.lastDeployResult.mirror, null);
    assert.match(document.getElementById('publish-output').textContent, /"status": "disabled"/);
});

test('an opted-in deployment publishes ?orc=<hash>&<locator> after a successful mirror', async () => {
    const uploads = [];
    const { context, url } = await deployContext({
        mirrorEnabled: true,
        gofileService: {
            upload: async (blob, options) => {
                uploads.push(options.filename);
                return { mirrorLocator: 'file_abc', filename: options.filename };
            }
        }
    });

    await context.deploySignedArtifact();

    assert.deepEqual(uploads, [gofileMirrorFilename(HASH_ONE)], 'the mirror is named for this deployment');
    assert.equal(url(), `https://web25.cloud/?orc=${HASH_ONE}&file_abc`);
    assert.equal(context.lastDeployResult.mirror.locator, 'file_abc');
    assert.match(document.getElementById('publish-output').textContent, /"status": "available"/);
});

test('immediate duplicate deploy calls share one mirror operation', async () => {
    let uploads = 0;
    let release;
    const { context } = await deployContext({
        mirrorEnabled: true,
        gofileService: {
            upload: async () => {
                uploads += 1;
                await new Promise((resolve) => {
                    release = resolve;
                });
                return { mirrorLocator: 'file_once' };
            }
        }
    });
    const first = context.deploySignedArtifact();
    const second = context.deploySignedArtifact();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second]);
    assert.equal(uploads, 1);
});

test('a stalled GoFile upload cannot hang or fail the deployment', async () => {
    let liveUrlWhileStalled = null;
    const { context, warnings, url } = await deployContext({ mirrorEnabled: true });
    context.gofileService = new GoFileService({
        fetchImpl: (_endpoint, init) =>
            new Promise((_resolve, reject) => {
                // The torrent result is already on screen before GoFile is even
                // given a chance to be slow.
                liveUrlWhileStalled = url();
                const socket = setTimeout(() => {}, 10000);
                init.signal.addEventListener('abort', () => {
                    clearTimeout(socket);
                    reject(init.signal.reason);
                });
            }),
        uploadTimeoutMs: 25
    });

    const started = Date.now();
    await context.deploySignedArtifact();

    assert.equal(liveUrlWhileStalled, `https://web25.cloud/?orc=${HASH_ONE}`);
    assert.ok(Date.now() - started < 5000, 'the deployment did not wait on GoFile indefinitely');
    assert.equal(url(), `https://web25.cloud/?orc=${HASH_ONE}`, 'the link falls back to the torrent-only address');
    assert.equal(context.lastDeployResult.mirror, null);
    assert.equal(document.getElementById('deploy-stage-label').textContent, 'Deployment complete');
    assert.match(document.getElementById('publish-output').textContent, /"status": "unavailable"/);
    assert.match(document.getElementById('publish-output').textContent, /timed out/i);
    assert.equal(warnings.length, 1, 'the failure is reported without blocking');
    assert.match(warnings[0], /deployed successfully/i);
    assert.match(warnings[0], /could not be created/i);
});

test('a rejected GoFile upload leaves the deployment successful', async () => {
    const { context, url, warnings } = await deployContext({
        mirrorEnabled: true,
        gofileService: {
            upload: async () => {
                throw new Error('GoFile rejected the upload.');
            }
        }
    });

    await context.deploySignedArtifact();

    assert.equal(url(), `https://web25.cloud/?orc=${HASH_ONE}`);
    assert.equal(context.lastDeployResult.hash, HASH_ONE);
    assert.equal(context.lastDeployResult.mirror, null);
    assert.equal(warnings.length, 1);
});

test('a second mirrored deployment cannot change the first one', async () => {
    let counter = 0;
    const service = {
        upload: async (_blob, options) => {
            counter += 1;
            return { mirrorLocator: `file_${counter}`, filename: options.filename };
        }
    };

    const first = await deployContext({ hash: HASH_ONE, mirrorEnabled: true, gofileService: service });
    await first.context.deploySignedArtifact();
    const firstUrl = first.url();
    const firstResult = { ...first.context.lastDeployResult };

    const second = await deployContext({ hash: HASH_TWO, mirrorEnabled: true, gofileService: service });
    await second.context.deploySignedArtifact();

    assert.equal(firstUrl, `https://web25.cloud/?orc=${HASH_ONE}&file_1`);
    assert.equal(second.url(), `https://web25.cloud/?orc=${HASH_TWO}&file_2`);
    assert.notEqual(firstResult.mirror.locator, second.context.lastDeployResult.mirror.locator);
    assert.notEqual(firstResult.mirror.filename, second.context.lastDeployResult.mirror.filename);
    assert.equal(firstResult.url, firstUrl, "the first deployment's link is untouched by the second");
});

test('an expired guest token is reset once and the retry keeps the same filename', async () => {
    const attempts = [];
    let cleared = 0;
    const { context } = await deployContext({
        mirrorEnabled: true,
        gofileService: {
            upload: async (_blob, options) => {
                attempts.push({ filename: options.filename, token: options.token || null });
                if (attempts.length === 1) {
                    const error = new Error('GoFile upload failed (HTTP 401).');
                    error.code = 'invalid_token';
                    throw error;
                }
                return { mirrorLocator: 'file_retry', filename: options.filename };
            }
        }
    });
    context.gofileCredentialStore = {
        read: async () => ({ token: 'expired-token' }),
        write: async () => {},
        clearInvalidToken: async () => {
            cleared += 1;
        }
    };

    await context.deploySignedArtifact();

    assert.equal(cleared, 1);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].token, 'expired-token');
    assert.equal(attempts[1].token, null);
    assert.equal(attempts[0].filename, attempts[1].filename);
    assert.equal(context.lastDeployResult.mirror.locator, 'file_retry');
});
