/**
 * Protected static-site content and capability grants.
 *
 * These tests exercise the whole path: a publisher selects text in the preview,
 * the fragment is encrypted and replaced by a placeholder, the manifest is
 * signed over the encrypted site, and a viewer either holds a grant or is told
 * — precisely — why they do not.
 *
 * Everything that must fail closed is checked as an outcome, not as an
 * implementation detail: a wrapped key from another asset, a substituted
 * ciphertext, an edited grant, a locked wallet mistaken for an unauthorised one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as ecies from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';
import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import {
    createProtectedAsset,
    findGrantForPublicKey,
    newUuid,
    normalizeRecipientPublicKey,
    PROTECTED_KEY_SCHEMA,
    ProtectedAssetError,
    protectedAssetCipherPath,
    TORRENTCHAIN_SCHEMA,
    unwrapAndDecryptProtectedAsset,
    validateProtectedAssets,
    verifyProtectedAssetCiphertext
} from '../src/torrent/ProtectedAssetProtocol.js';
import { buildProtectedSite, prepareProtectionWorkspace } from '../src/torrent/ProtectedSiteBuilder.js';
import { applyProtectedSelections, prepareAuthoringDocument, serializeStagedDocument } from '../src/torrent/ProtectedTextLocator.js';
import { parseAuthoringHtml, RAW_TEXT_ELEMENTS, serializeAuthoringHtml, textContentOf } from '../src/torrent/AuthoringDom.js';
import { buildSandboxBootstrapHtml } from '../src/core/renderer/SandboxBootstrap.js';
import {
    createProtectedAssetDecryptHandler,
    PROTECTED_DECRYPT_STATUS,
    verifyProtectedAssetsAgainstBundle,
    WALLET_LOCKED_MESSAGE
} from '../src/core/renderer/ProtectedAssetRuntime.js';
import { canonicalJson } from '../src/torrent/CanonicalJson.js';

// ─── fixtures ────────────────────────────────────────────────────────────

const OWNER_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const GUEST_KEY = '0x2222222222222222222222222222222222222222222222222222222222222222';
const STRANGER_KEY = '0x3333333333333333333333333333333333333333333333333333333333333333';

const OWNER_PUB = ecies.getPublicKeyFromPrivateKey(OWNER_KEY);
const GUEST_PUB = ecies.getPublicKeyFromPrivateKey(GUEST_KEY);
const STRANGER_PUB = ecies.getPublicKeyFromPrivateKey(STRANGER_KEY);

const OWNER_ADDRESS = ecies.evmAddressFromPublicKey(OWNER_PUB);
const OWNER_NOSTR = nostrCore.getNostrPublicKey(OWNER_KEY);
const OWNER_NPUB = npubEncode(OWNER_NOSTR);

const SITE_HTML =
    '<!DOCTYPE html>\n<html><body>\n<p id="lede">Public opener. <b>Members only</b> tail text.</p>\n' +
    '<div class="pricing">Rate card: <em>$4,200</em> per month</div>\n</body></html>';

const ECIES_HANDLE = {
    eciesEncrypt: ecies.eciesEncrypt,
    evmAddressFromPublicKey: ecies.evmAddressFromPublicKey,
    isValidUncompressedPublicKey: ecies.isValidUncompressedPublicKey
};

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);

function stagedSite(html = SITE_HTML) {
    return [
        { path: 'index.html', contentType: 'text/html', bytes: encode(html) },
        { path: 'assets/app.js', contentType: 'text/javascript', bytes: encode('console.log("hi")') }
    ];
}

/** The locator the preview frame would report for a run of text on a page. */
function selectionFor(document_, containerTag, needle) {
    let container = null;
    let containerId = null;
    for (const [id, element] of document_.previewIndex) {
        if (element.tag !== containerTag) continue;
        if (textContentOf(element).includes(needle)) {
            container = element;
            containerId = id;
            break;
        }
    }
    assert.ok(container, `no <${containerTag}> containing ${JSON.stringify(needle)}`);

    const text = textContentOf(container);
    const startOffset = text.indexOf(needle);
    const endOffset = startOffset + needle.length;
    return {
        path: document_.path,
        containerId,
        startOffset,
        endOffset,
        exact: needle,
        prefix: text.slice(Math.max(0, startOffset - 32), startOffset),
        suffix: text.slice(endOffset, endOffset + 32)
    };
}

/** Build a protected site the way the Preview & Protect step does. */
async function protectSite({ selections, html = SITE_HTML } = {}) {
    const files = stagedSite(html);
    const workspace = prepareProtectionWorkspace(files);
    const document_ = workspace.get('index.html');

    const requests = (selections || []).map(({ needle, tag = 'p', recipientPublicKeys = [] }) => ({
        locator: selectionFor(document_, tag, needle),
        recipientPublicKeys
    }));

    const built = await buildProtectedSite({
        files,
        selections: requests,
        owner: { eciesPublicKey: OWNER_PUB },
        ecies: ECIES_HANDLE
    });

    const assets = await validateProtectedAssets(built.protectedAssets, { siteId: built.siteId });
    return { ...built, assets, originalFiles: files };
}

/** The `siteData` shape the loader hands to the renderer. */
function siteDataFrom(files) {
    const siteData = {};
    for (const file of files) {
        siteData[file.path] = { content: file.bytes, type: file.contentType, size: file.bytes.length };
    }
    return siteData;
}

/** A wallet worker, optionally left locked. */
function walletHarness(privateKey) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let counter = 0;
    let unlocked = false;

    const send = (type, payload) => core.handle({ id: `t${(counter += 1)}`, type, payload });

    return {
        core,
        async unlock() {
            const response = await send(WALLET_WORKER_OPS.UNLOCK, { privateKey });
            assert.equal(response.ok, true, response.error);
            unlocked = true;
        },
        isUnlocked: async () => unlocked,
        publicKey: async () => (unlocked ? ecies.getPublicKeyFromPrivateKey(privateKey) : null),
        /** Exactly the narrow worker call the application makes. */
        decrypt: async (request) => {
            const response = await send(WALLET_WORKER_OPS.PROTECTED_ASSET_DECRYPT, request);
            if (!response.ok) throw new Error(response.error);
            return response.result;
        },
        dispose: () => core.dispose()
    };
}

/** Wire a viewer to a verified site exactly as `Navigation.js` does. */
async function viewerFor({ built, wallet, owner = { npub: OWNER_NPUB, nostrPublicKey: OWNER_NOSTR }, assets = null }) {
    const verification = await verifyProtectedAssetsAgainstBundle({
        protectedAssets: assets || built.assets,
        siteData: siteDataFrom(built.files)
    });
    return {
        verification,
        handler: createProtectedAssetDecryptHandler({
            siteId: built.siteId,
            owner,
            assets: verification.assets,
            isWalletUnlocked: () => wallet.isUnlocked(),
            getViewerPublicKey: () => wallet.publicKey(),
            decryptProtectedAsset: (request) => wallet.decrypt(request)
        })
    };
}

// ─── 1. a deploy that protects nothing ───────────────────────────────────

test('a deploy with zero protected assets leaves the staged site byte-identical', async () => {
    const files = stagedSite();
    const built = await buildProtectedSite({
        files,
        selections: [],
        owner: { eciesPublicKey: OWNER_PUB },
        ecies: ECIES_HANDLE
    });

    assert.deepEqual(built.protectedAssets, []);
    assert.deepEqual(built.changedPaths, []);
    assert.deepEqual(
        built.files.map((file) => file.path),
        ['index.html', 'assets/app.js'],
        'no ciphertext file is added when nothing is protected'
    );
    assert.equal(decode(built.files[0].bytes), SITE_HTML, 'the HTML is untouched, down to the byte');
});

test('an authoring round trip with no selections reproduces the source exactly', () => {
    const document_ = prepareAuthoringDocument(SITE_HTML, 'index.html');
    assert.match(document_.previewHtml, /data-web25-node="w0"/, 'the preview carries temporary node ids');
    assert.equal(serializeStagedDocument(document_), SITE_HTML, 'and the built file carries none of them');
});

// ─── 2. preview selection → placeholder ──────────────────────────────────

test('a preview selection becomes a deterministic placeholder in the staged HTML', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    const html = decode(built.files.find((file) => file.path === 'index.html').bytes);
    const assetId = built.assets[0].assetId;

    assert.match(html, new RegExp(`<web25-protected data-asset-id="${assetId}"></web25-protected>`));
    assert.ok(!html.includes('Members only'), 'the plaintext is gone from the published HTML');
    assert.ok(!html.includes('data-web25-node'), 'preview-only ids never reach the built file');
    assert.equal(built.assets[0].source.path, 'index.html');
    assert.equal(built.assets[0].source.locator.containerPath, 'html[1]/body[1]/p[1]');
});

test('the published locator records where a fragment was, never what it said', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    const serialized = canonicalJson(built.assets[0]);

    assert.ok(!serialized.includes('Members only'), 'the manifest never carries the protected text');
    assert.ok(!serialized.includes('Public opener'), 'nor the text around it');
    assert.deepEqual(Object.keys(built.assets[0].source.locator).sort(), [
        'containerPath',
        'endOffset',
        'length',
        'startOffset',
        'type'
    ]);
});

test('a selection spanning inline markup keeps its structure and restores exactly', async () => {
    const html = '<html><body><p>Keep <b>this <i>whole</i> phrase</b> please</p></body></html>';
    const built = await protectSite({ selections: [{ needle: 'this whole phrase' }], html });

    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();
    const { handler } = await viewerFor({ built, wallet });
    const result = await handler(built.assets[0].assetId);

    assert.equal(result.status, PROTECTED_DECRYPT_STATUS.OK);
    assert.equal(result.html, 'this <i>whole</i> phrase');

    const staged = decode(built.files.find((file) => file.path === 'index.html').bytes);
    const restored = staged.replace(
        `<web25-protected data-asset-id="${built.assets[0].assetId}"></web25-protected>`,
        result.html
    );
    assert.equal(restored, html, 'a successful decrypt restores the original document');
    wallet.dispose();
});

// ─── 3 & 4. one and many protected fragments ─────────────────────────────

test('one protected fragment encrypts once and ships one ciphertext file', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only', recipientPublicKeys: [GUEST_PUB] }] });

    assert.equal(built.assets.length, 1);
    const asset = built.assets[0];
    assert.equal(asset.cipherPath, protectedAssetCipherPath(asset.assetId));
    assert.equal(asset.cipher.algorithm, 'AES-256-GCM');

    const cipherFiles = built.files.filter((file) => file.path.startsWith('.web25/protected/'));
    assert.equal(cipherFiles.length, 1, 'one ciphertext, not one copy per recipient');
    assert.equal(asset.grants.length, 2, 'owner plus the invited recipient');
});

test('multiple protected fragments each get their own asset, key and ciphertext', async () => {
    const built = await protectSite({
        selections: [
            { needle: 'Members only', tag: 'p' },
            { needle: '$4,200', tag: 'div' }
        ]
    });

    assert.equal(built.assets.length, 2);
    const [first, second] = built.assets;
    assert.notEqual(first.assetId, second.assetId);
    assert.notEqual(first.contentHash, second.contentHash);
    assert.notEqual(first.cipherHash, second.cipherHash);
    assert.notEqual(first.cipher.iv, second.cipher.iv);

    const html = decode(built.files.find((file) => file.path === 'index.html').bytes);
    assert.ok(!html.includes('Members only'));
    assert.ok(!html.includes('$4,200'));
    assert.equal((html.match(/<web25-protected /g) || []).length, 2);
    assert.equal(built.files.filter((file) => file.path.startsWith('.web25/protected/')).length, 2);

    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();
    const { handler } = await viewerFor({ built, wallet });
    const opened = await Promise.all(built.assets.map((asset) => handler(asset.assetId)));
    // Each selection was the whole text of an inline element, so the
    // placeholder sits inside that element and the fragment is its text: a
    // successful decrypt restores the markup exactly as it was.
    assert.deepEqual(opened.map((result) => result.html).sort(), ['$4,200', 'Members only'].sort());
    wallet.dispose();
});

// ─── 5, 6, 7, 8. who can open what ───────────────────────────────────────

test('the owner can always decrypt, even when no recipient was invited', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    assert.equal(built.assets[0].grants.length, 1);
    assert.equal(built.assets[0].grants[0].recipientPublicKey, OWNER_PUB.toLowerCase());
    assert.equal(built.assets[0].grants[0].recipientAddress, OWNER_ADDRESS.toLowerCase());

    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();
    const { handler } = await viewerFor({ built, wallet });

    const result = await handler(built.assets[0].assetId);
    assert.equal(result.status, PROTECTED_DECRYPT_STATUS.OK);
    assert.equal(result.html, 'Members only');
    wallet.dispose();
});

test('an authorised recipient decrypts successfully', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only', recipientPublicKeys: [GUEST_PUB] }] });

    const wallet = walletHarness(GUEST_KEY);
    await wallet.unlock();
    const { handler } = await viewerFor({ built, wallet });

    const result = await handler(built.assets[0].assetId);
    assert.equal(result.status, PROTECTED_DECRYPT_STATUS.OK);
    assert.equal(result.html, 'Members only');
    wallet.dispose();
});

test('an unauthorised wallet is refused before any crypto is attempted', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only', recipientPublicKeys: [GUEST_PUB] }] });

    const wallet = walletHarness(STRANGER_KEY);
    await wallet.unlock();

    let workerCalls = 0;
    const verification = await verifyProtectedAssetsAgainstBundle({
        protectedAssets: built.assets,
        siteData: siteDataFrom(built.files)
    });
    const handler = createProtectedAssetDecryptHandler({
        siteId: built.siteId,
        owner: { npub: OWNER_NPUB },
        assets: verification.assets,
        isWalletUnlocked: () => wallet.isUnlocked(),
        getViewerPublicKey: () => wallet.publicKey(),
        decryptProtectedAsset: (request) => {
            workerCalls += 1;
            return wallet.decrypt(request);
        }
    });

    const result = await handler(built.assets[0].assetId);
    assert.equal(result.status, PROTECTED_DECRYPT_STATUS.NO_GRANT);
    assert.equal(workerCalls, 0, 'no grant means the wallet worker is never asked');
    assert.ok(!('html' in result));
    wallet.dispose();
});

test('a locked wallet is told to unlock, never that it lacks access', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only', recipientPublicKeys: [GUEST_PUB] }] });

    // The very wallet that *does* hold a grant, simply not unlocked yet.
    const wallet = walletHarness(GUEST_KEY);
    const { handler } = await viewerFor({ built, wallet });

    const locked = await handler(built.assets[0].assetId);
    assert.equal(locked.status, PROTECTED_DECRYPT_STATUS.WALLET_LOCKED);
    assert.equal(locked.message, WALLET_LOCKED_MESSAGE);
    assert.doesNotMatch(locked.message, /do not have/i, 'a locked wallet is not reported as missing access');

    await wallet.unlock();
    const opened = await handler(built.assets[0].assetId);
    assert.equal(opened.status, PROTECTED_DECRYPT_STATUS.OK, 'unlocking is all that was missing');
    wallet.dispose();
});

// ─── 15. the author a locked-out viewer should ask ───────────────────────

test('a viewer without a grant is shown the verified owner npub', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });

    const wallet = walletHarness(STRANGER_KEY);
    await wallet.unlock();
    const { handler } = await viewerFor({ built, wallet });

    const result = await handler(built.assets[0].assetId);
    assert.equal(result.status, PROTECTED_DECRYPT_STATUS.NO_GRANT);
    assert.match(result.message, /You do not have decryption rights for this content\./);
    assert.match(result.message, new RegExp(`Author: ${OWNER_NPUB}`));
    assert.equal(result.authorNpub, OWNER_NPUB);
    wallet.dispose();
});

// ─── 9. recipient key validation ─────────────────────────────────────────

test('a bare Ethereum address is rejected as encryption material', () => {
    assert.throws(
        () => normalizeRecipientPublicKey(OWNER_ADDRESS, ECIES_HANDLE),
        (error) => error instanceof ProtectedAssetError && error.code === 'recipient-address-not-a-key'
    );
});

test('malformed and off-curve recipient keys are rejected, valid ones derive their address', () => {
    const rejected = [
        '',
        'not-a-key',
        `04${'11'.repeat(64)}`, // well-formed shape, not a point on the curve
        OWNER_PUB.slice(0, -2), // truncated
        `02${OWNER_PUB.slice(2, 66)}` // compressed form is not accepted here
    ];
    for (const candidate of rejected) {
        assert.throws(
            () => normalizeRecipientPublicKey(candidate, ECIES_HANDLE),
            ProtectedAssetError,
            `${JSON.stringify(candidate)} must be refused`
        );
    }

    assert.equal(normalizeRecipientPublicKey(`0x${OWNER_PUB.toUpperCase()}`, ECIES_HANDLE), OWNER_PUB.toLowerCase());
    assert.equal(ecies.evmAddressFromPublicKey(OWNER_PUB), OWNER_ADDRESS);
});

test('a protected build refuses an invalid recipient key outright', async () => {
    const files = stagedSite();
    const document_ = prepareProtectionWorkspace(files).get('index.html');
    await assert.rejects(
        buildProtectedSite({
            files,
            selections: [{ locator: selectionFor(document_, 'p', 'Members only'), recipientPublicKeys: [OWNER_ADDRESS] }],
            owner: { eciesPublicKey: OWNER_PUB },
            ecies: ECIES_HANDLE
        }),
        /not encryption material/
    );
});

// ─── 10 & 11. tampering ──────────────────────────────────────────────────

test('modified ciphertext is rejected before the site renders', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    const siteData = siteDataFrom(built.files);
    const cipherEntry = siteData[built.assets[0].cipherPath];
    cipherEntry.content = Uint8Array.from(cipherEntry.content);
    cipherEntry.content[0] ^= 0x01;

    const verification = await verifyProtectedAssetsAgainstBundle({ protectedAssets: built.assets, siteData });
    assert.equal(verification.ok, false);
    assert.match(verification.reason, /Ciphertext hash mismatch/);
});

test('modified ciphertext also fails inside the worker, not only at the gate', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    const asset = built.assets[0];
    const ciphertext = Uint8Array.from(built.files.find((file) => file.path === asset.cipherPath).bytes);
    ciphertext[ciphertext.length - 1] ^= 0x01;

    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();
    await assert.rejects(
        wallet.decrypt({
            schema: TORRENTCHAIN_SCHEMA,
            siteId: built.siteId,
            assetId: asset.assetId,
            contentHash: asset.contentHash,
            cipherHash: asset.cipherHash,
            contentSalt: asset.contentSalt,
            iv: asset.cipher.iv,
            algorithm: asset.cipher.algorithm,
            wrappedKey: asset.grants[0].wrappedKey,
            ciphertext
        }),
        /does not match the hash in the signed manifest/
    );
    wallet.dispose();
});

test('an edited grant is rejected: hashes bind the recipient to the asset', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only', recipientPublicKeys: [GUEST_PUB] }] });

    const swappedRecipient = JSON.parse(JSON.stringify(built.assets));
    swappedRecipient[0].grants[1].recipientPublicKey = STRANGER_PUB.toLowerCase();
    await assert.rejects(
        validateProtectedAssets(swappedRecipient, { siteId: built.siteId }),
        /Grant hash mismatch/,
        'a grant cannot be re-pointed at another recipient'
    );

    const editedHash = JSON.parse(JSON.stringify(built.assets));
    editedHash[0].grants[0].grantHash = editedHash[0].grants[0].grantHash.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    await assert.rejects(validateProtectedAssets(editedHash, { siteId: built.siteId }), /Grant hash mismatch/);

    const duplicated = JSON.parse(JSON.stringify(built.assets));
    duplicated[0].grants.push({ ...duplicated[0].grants[0] });
    await assert.rejects(validateProtectedAssets(duplicated, { siteId: built.siteId }), /Conflicting grants/);
});

test('duplicate asset ids and mismatched AADs are rejected', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });

    const duplicated = [built.assets[0], JSON.parse(JSON.stringify(built.assets[0]))];
    await assert.rejects(validateProtectedAssets(duplicated, { siteId: built.siteId }), /Duplicate protected assetId/);

    const wrongAad = JSON.parse(JSON.stringify(built.assets));
    wrongAad[0].cipher.aad = canonicalJson({
        schema: TORRENTCHAIN_SCHEMA,
        siteId: built.siteId,
        assetId: wrongAad[0].assetId,
        contentHash: 'f'.repeat(64)
    });
    await assert.rejects(validateProtectedAssets(wrongAad, { siteId: built.siteId }), /mismatched AAD/);

    // The same asset, verified against a different site, must not pass.
    await assert.rejects(validateProtectedAssets(built.assets, { siteId: newUuid() }), /mismatched AAD/);
});

test('a missing protected asset blocks the render', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    const siteData = siteDataFrom(built.files.filter((file) => !file.path.startsWith('.web25/protected/')));

    const verification = await verifyProtectedAssetsAgainstBundle({ protectedAssets: built.assets, siteData });
    assert.equal(verification.ok, false);
    assert.match(verification.reason, /missing its ciphertext/);
});

// ─── 12 & 13. cross-swapping between assets ──────────────────────────────

test('a wrapped key from asset A cannot decrypt asset B', async () => {
    const built = await protectSite({
        selections: [
            { needle: 'Members only', tag: 'p' },
            { needle: '$4,200', tag: 'div' }
        ]
    });
    const [assetA, assetB] = built.assets;

    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();
    await assert.rejects(
        wallet.decrypt({
            schema: TORRENTCHAIN_SCHEMA,
            siteId: built.siteId,
            assetId: assetB.assetId,
            contentHash: assetB.contentHash,
            cipherHash: assetB.cipherHash,
            contentSalt: assetB.contentSalt,
            iv: assetB.cipher.iv,
            algorithm: assetB.cipher.algorithm,
            // The one substitution: A's wrapped key on B's asset.
            wrappedKey: assetA.grants[0].wrappedKey,
            ciphertext: built.files.find((file) => file.path === assetB.cipherPath).bytes
        }),
        /belongs to a different protected asset/
    );
    wallet.dispose();
});

test('ciphertext from asset A cannot be substituted for asset B', async () => {
    const built = await protectSite({
        selections: [
            { needle: 'Members only', tag: 'p' },
            { needle: '$4,200', tag: 'div' }
        ]
    });
    const [assetA, assetB] = built.assets;

    // Swapping the files on disk is caught before anything renders …
    const siteData = siteDataFrom(built.files);
    siteData[assetB.cipherPath] = { ...siteData[assetA.cipherPath] };
    const verification = await verifyProtectedAssetsAgainstBundle({ protectedAssets: built.assets, siteData });
    assert.equal(verification.ok, false);
    assert.match(verification.reason, /Ciphertext hash mismatch/);

    // … and again inside the worker, which trusts nothing it is handed.
    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();
    await assert.rejects(
        wallet.decrypt({
            schema: TORRENTCHAIN_SCHEMA,
            siteId: built.siteId,
            assetId: assetB.assetId,
            contentHash: assetB.contentHash,
            cipherHash: assetB.cipherHash,
            contentSalt: assetB.contentSalt,
            iv: assetB.cipher.iv,
            algorithm: assetB.cipher.algorithm,
            wrappedKey: assetB.grants[0].wrappedKey,
            ciphertext: built.files.find((file) => file.path === assetA.cipherPath).bytes
        }),
        /does not match the hash in the signed manifest/
    );
    wallet.dispose();
});

test('a wrapped key from another site cannot open this one', async () => {
    const siteA = newUuid();
    const siteB = newUuid();
    const assetId = newUuid();

    const inA = await createProtectedAsset({
        siteId: siteA,
        assetId,
        plaintext: 'shared text',
        source: { path: 'index.html', locator: {} },
        recipientPublicKeys: [OWNER_PUB],
        ecies: ECIES_HANDLE
    });
    const inB = await createProtectedAsset({
        siteId: siteB,
        assetId,
        plaintext: 'shared text',
        source: { path: 'index.html', locator: {} },
        recipientPublicKeys: [OWNER_PUB],
        ecies: ECIES_HANDLE
    });

    await assert.rejects(
        unwrapAndDecryptProtectedAsset({
            siteId: siteB,
            assetId,
            contentHash: inB.asset.contentHash,
            cipherHash: inB.asset.cipherHash,
            contentSalt: inB.asset.contentSalt,
            iv: inB.asset.cipher.iv,
            algorithm: inB.asset.cipher.algorithm,
            wrappedKey: inA.asset.grants[0].wrappedKey,
            ciphertext: inB.ciphertext,
            eciesDecrypt: (wrapped) => ecies.eciesDecrypt(wrapped, OWNER_KEY)
        }),
        /belongs to a different site/
    );
});

// ─── 14. the plaintext digest is checked after decryption ────────────────

test('the content hash is verified after decryption, not only before', async () => {
    const siteId = newUuid();
    const assetId = newUuid();
    const { asset, ciphertext } = await createProtectedAsset({
        siteId,
        assetId,
        plaintext: '<b>Members only</b>',
        source: { path: 'index.html', locator: {} },
        recipientPublicKeys: [OWNER_PUB],
        ecies: ECIES_HANDLE
    });

    // A tampered envelope that claims a different salt would make the recovered
    // plaintext hash to something else; the check that catches it runs after
    // the AEAD has already succeeded.
    await assert.rejects(
        unwrapAndDecryptProtectedAsset({
            siteId,
            assetId,
            contentHash: asset.contentHash,
            cipherHash: asset.cipherHash,
            contentSalt: 'ab'.repeat(16),
            iv: asset.cipher.iv,
            algorithm: asset.cipher.algorithm,
            wrappedKey: asset.grants[0].wrappedKey,
            ciphertext,
            eciesDecrypt: (wrapped) => ecies.eciesDecrypt(wrapped, OWNER_KEY)
        }),
        /does not match the signed content hash/
    );

    const envelope = JSON.parse(await ecies.eciesDecrypt(asset.grants[0].wrappedKey, OWNER_KEY));
    assert.equal(envelope.schema, PROTECTED_KEY_SCHEMA);
    assert.equal(envelope.assetId, assetId);
    assert.equal(envelope.siteId, siteId);
    assert.equal(envelope.contentHash, asset.contentHash);
    assert.equal(envelope.cipherHash, asset.cipherHash);
});

test('an AAD the worker did not derive itself cannot be forced in', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    const asset = built.assets[0];
    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();

    // The AAD is a function of siteId + assetId + contentHash, so naming a
    // different content hash both breaks the envelope check and, past it, the
    // GCM tag. Either way, nothing comes back.
    await assert.rejects(
        wallet.decrypt({
            schema: TORRENTCHAIN_SCHEMA,
            siteId: built.siteId,
            assetId: asset.assetId,
            contentHash: '0'.repeat(64),
            cipherHash: asset.cipherHash,
            contentSalt: asset.contentSalt,
            iv: asset.cipher.iv,
            algorithm: asset.cipher.algorithm,
            wrappedKey: asset.grants[0].wrappedKey,
            ciphertext: built.files.find((file) => file.path === asset.cipherPath).bytes
        }),
        /names a different content hash/
    );
    wallet.dispose();
});

// ─── unresolvable selections are refused, never guessed ──────────────────

test('a selection that cannot be mapped back to the source is rejected', () => {
    const document_ = prepareAuthoringDocument(SITE_HTML, 'index.html');
    const good = selectionFor(document_, 'p', 'Members only');

    const broken = [
        { ...good, exact: 'Members onlz' },
        { ...good, prefix: 'nothing like the source' },
        { ...good, suffix: 'nothing like the source' },
        { ...good, containerId: 'w999' },
        { ...good, startOffset: good.endOffset, endOffset: good.startOffset },
        { ...good, endOffset: good.startOffset + 10_000 }
    ];

    for (const locator of broken) {
        assert.throws(
            () => applyProtectedSelections(prepareAuthoringDocument(SITE_HTML, 'index.html'), [{ assetId: newUuid(), locator }]),
            /could not|does not match|not part of|past the end|offsets|length/i,
            `${JSON.stringify(locator).slice(0, 80)} must be refused`
        );
    }
});

test('overlapping selections are refused rather than merged', () => {
    const document_ = prepareAuthoringDocument(SITE_HTML, 'index.html');
    const first = selectionFor(document_, 'p', 'Public opener. Members');
    const second = selectionFor(document_, 'p', 'Members only');

    assert.throws(
        () =>
            applyProtectedSelections(prepareAuthoringDocument(SITE_HTML, 'index.html'), [
                { assetId: newUuid(), locator: first },
                { assetId: newUuid(), locator: second }
            ]),
        /overlap/
    );
});

test('a selection naming a file that is not staged is refused', async () => {
    const files = stagedSite();
    const document_ = prepareProtectionWorkspace(files).get('index.html');
    await assert.rejects(
        buildProtectedSite({
            files,
            selections: [{ locator: { ...selectionFor(document_, 'p', 'Members only'), path: 'other.html' } }],
            owner: { eciesPublicKey: OWNER_PUB },
            ecies: ECIES_HANDLE
        }),
        /not staged/
    );
});

// ─── 16. nothing decrypted is ever persisted ─────────────────────────────

test('a decrypted fragment is never written to any cache or storage', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    const plaintext = 'Members only';

    // Everything that reaches durable storage is the site data itself.
    const siteData = siteDataFrom(built.files);
    const persisted = Object.entries(siteData)
        .map(([path, entry]) => `${path}:${decode(entry.content)}`)
        .join('\n');
    assert.ok(!persisted.includes('Members only'), 'the cached bundle carries ciphertext only');

    const writes = [];
    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();
    const verification = await verifyProtectedAssetsAgainstBundle({ protectedAssets: built.assets, siteData });
    const handler = createProtectedAssetDecryptHandler({
        siteId: built.siteId,
        owner: { npub: OWNER_NPUB },
        assets: verification.assets,
        isWalletUnlocked: () => wallet.isUnlocked(),
        getViewerPublicKey: () => wallet.publicKey(),
        decryptProtectedAsset: (request) => wallet.decrypt(request)
    });

    // Any persistence the handler attempted would have to go through one of
    // these; the decrypt path touches none of them.
    for (const store of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
        Object.defineProperty(globalThis, store, {
            configurable: true,
            value: new Proxy(
                {},
                {
                    get(_target, property) {
                        writes.push(`${store}.${String(property)}`);
                        return () => {};
                    }
                }
            )
        });
    }

    try {
        const result = await handler(built.assets[0].assetId);
        assert.equal(result.html, plaintext, 'the fragment comes back in memory');
        assert.deepEqual(writes, [], 'and nothing was written anywhere');
    } finally {
        for (const store of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
            delete globalThis[store];
        }
        wallet.dispose();
    }

    // The site data is unchanged by the decryption that just happened.
    assert.equal(
        Object.entries(siteData)
            .map(([path, entry]) => `${path}:${decode(entry.content)}`)
            .join('\n'),
        persisted
    );
});

test('the wallet worker returns a fragment and never the content key', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    const asset = built.assets[0];
    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();

    const result = await wallet.decrypt({
        schema: TORRENTCHAIN_SCHEMA,
        siteId: built.siteId,
        assetId: asset.assetId,
        contentHash: asset.contentHash,
        cipherHash: asset.cipherHash,
        contentSalt: asset.contentSalt,
        iv: asset.cipher.iv,
        algorithm: asset.cipher.algorithm,
        wrappedKey: asset.grants[0].wrappedKey,
        ciphertext: built.files.find((file) => file.path === asset.cipherPath).bytes
    });

    assert.deepEqual(Object.keys(result).sort(), ['assetId', 'plaintext']);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(OWNER_KEY.slice(2)), 'the private key never leaves the worker');
    assert.ok(!serialized.includes('cek'), 'nor does the content key');
    wallet.dispose();
});

// ─── an unknown asset id gets nowhere ────────────────────────────────────

test('an asset id that is not in the verified manifest is refused outright', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();
    const { handler } = await viewerFor({ built, wallet });

    const result = await handler(newUuid());
    assert.equal(result.status, PROTECTED_DECRYPT_STATUS.UNKNOWN_ASSET);
    assert.ok(!('html' in result));
    wallet.dispose();
});

test('a grant lookup ignores casing but never matches a different key', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only', recipientPublicKeys: [GUEST_PUB] }] });
    const asset = built.assets[0];

    assert.ok(findGrantForPublicKey(asset, GUEST_PUB.toUpperCase()));
    assert.equal(findGrantForPublicKey(asset, STRANGER_PUB), null);
    assert.equal(findGrantForPublicKey(asset, 'not-a-key'), null);
    assert.equal(findGrantForPublicKey(asset, OWNER_ADDRESS), null, 'an address is not a key');
});

test('a verified ciphertext passes the same check the loader runs', async () => {
    const built = await protectSite({ selections: [{ needle: 'Members only' }] });
    const asset = built.assets[0];
    const ciphertext = built.files.find((file) => file.path === asset.cipherPath).bytes;
    assert.equal(await verifyProtectedAssetCiphertext(asset, ciphertext), true);
    await assert.rejects(verifyProtectedAssetCiphertext(asset, null), /missing its ciphertext/);
});


// ─── the authoring document and the preview frame must agree ─────────────

test('the preview frame skips exactly the subtrees the staged source skips', () => {
    // Offsets are only meaningful if both sides count the same characters, so
    // the two exclusion lists are pinned against each other rather than left to
    // drift apart silently.
    const bootstrap = buildSandboxBootstrapHtml({
        token: 'tok',
        parentOrigin: 'https://web25.cloud',
        prefix: '/peerweb-site/x/',
        mode: 'authoring',
        protectedEnabled: false
    });
    const declaration = bootstrap.match(/var SKIP_TEXT_TAGS = \{([^}]*)\}/);
    assert.ok(declaration, 'the frame declares its skip list');

    const frameTags = declaration[1]
        .split(',')
        .map((entry) => entry.split(':')[0].trim().toLowerCase())
        .filter(Boolean)
        .sort();
    assert.deepEqual(frameTags, [...RAW_TEXT_ELEMENTS].sort());
});

test('a realistic page survives the authoring round trip byte for byte', () => {
    const page = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head><meta charset="utf-8"><title>Docs &amp; Pricing</title>',
        '<style>.p{color:red} a>b{content:"</p>"}</style></head>',
        '<body>',
        '<!-- a comment with <tags> inside -->',
        '<h1 class=\'single\'>Pricing</h1>',
        '<p class="p">Free tier. <strong>Paid is $4,200/mo</strong> &mdash; ask.</p>',
        '<ul><li>One<li>Two &amp; a half</ul>',
        '<img src="x.png" alt="a > b">',
        '<script>if (1<2) { document.title = "</p>" }</script>',
        '</body></html>'
    ].join('\n');

    const document_ = parseAuthoringHtml(page);
    assert.equal(serializeAuthoringHtml(document_), page, 'nothing is normalised, rewritten or reordered');

    // Raw-text bodies are not selectable prose and are not counted.
    const text = textContentOf(document_);
    assert.ok(!text.includes('color:red'), 'CSS is not selectable text');
    assert.ok(!text.includes('document.title'), 'script source is not selectable text');
    assert.ok(text.includes('Two & a half'), 'entities are decoded the way a browser decodes them');
});

test('a protected fragment re-encodes the entities it took from the source', async () => {
    const html = '<html><body><p>Ratio: <b>3 &lt; 4 &amp; 5</b> exactly</p></body></html>';
    const built = await protectSite({ selections: [{ needle: '3 < 4 & 5' }], html });

    const wallet = walletHarness(OWNER_KEY);
    await wallet.unlock();
    const { handler } = await viewerFor({ built, wallet });
    const result = await handler(built.assets[0].assetId);

    assert.equal(result.html, '3 &lt; 4 &amp; 5', 'the fragment is markup, not decoded text');
    const staged = decode(built.files.find((file) => file.path === 'index.html').bytes);
    assert.equal(
        staged.replace(`<web25-protected data-asset-id="${built.assets[0].assetId}"></web25-protected>`, result.html),
        html
    );
    wallet.dispose();
});
