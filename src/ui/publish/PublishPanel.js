// @ts-check

export function bindPublishActions({ onSign, onPublish }) {
    const signBtn = document.getElementById('sign-publish-btn');
    const publishBtn = document.getElementById('publish-btn');

    if (signBtn) signBtn.addEventListener('click', onSign);
    if (publishBtn) publishBtn.addEventListener('click', onPublish);
}

export function setPublishButtonsState({ canSign, canDeploy }) {
    const signBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('sign-publish-btn'));
    const publishBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('publish-btn'));

    if (signBtn) {
        signBtn.disabled = !canSign;
        signBtn.classList.toggle('btn-disabled', !canSign);
    }

    if (publishBtn) {
        publishBtn.disabled = !canDeploy;
        publishBtn.classList.toggle('btn-disabled', !canDeploy);
    }
}

export function renderDeployStage(stage, detail = '') {
    const label = document.getElementById('deploy-stage-label');
    const detailEl = document.getElementById('deploy-stage-detail');

    if (label) label.textContent = stage;
    if (detailEl) detailEl.textContent = detail;
}

/**
 * Fill the WEB25 bundle and EVM signature panes in "View technical details".
 *
 * These are kept in their own sections so the two signatures involved in a
 * deployment stay visually distinct: the EVM signature below proves the
 * *website* publisher, and is produced exactly once per artifact. The Nostr
 * signature on the registry event is a separate section further down.
 *
 * @param {{ payload?: any, signature?: any, bundleMode?: string }} details
 */
export function renderDeployArtifactDetails({ payload = null, signature = null, bundleMode = 'gzip' }) {
    const bundleEl = document.getElementById('deploy-bundle-preview');
    const signatureEl = document.getElementById('deploy-evm-signature-preview');

    if (bundleEl) {
        bundleEl.textContent = payload
            ? JSON.stringify(
                  {
                      bundleMode,
                      schema: payload.bundle?.schema || payload.schema,
                      bundleFile: payload.bundle?.name || '(files mode — no single bundle file)',
                      bundleSha256: payload.bundle?.sha256 || null,
                      contentEncoding: payload.bundle?.contentEncoding || null,
                      fileCount: payload.fileCount,
                      totalBytes: payload.totalBytes,
                      merkleRoot: payload.merkleRoot,
                      filesSemantics: payload.filesSemantics
                  },
                  null,
                  2
              )
            : 'No bundle has been built for this session yet.';
    }

    if (signatureEl) {
        signatureEl.textContent = signature
            ? JSON.stringify(
                  {
                      algorithm: signature.signatureAlgorithm || 'EVM_SECP256K1',
                      publisher: payload?.publisher || null,
                      signedAt: signature.signedAt || payload?.createdAt || null,
                      signedMessage: signature.message,
                      signature: signature.signature,
                      note: 'Signed once, when .torrentchain was generated. Registry publication mirrors this signature and never creates another.'
                  },
                  null,
                  2
              )
            : 'The artifact has not been signed yet.';
    }
}

/**
 * The deployment outcome, shown separately from registry publication: a site
 * stays live and seeding whatever the NosNS directory relay did.
 * @param {'seeding'|'pending'} state
 */
export function renderDeploymentStatus(state) {
    const el = document.getElementById('result-deployment-status');
    if (!el) return;
    if (state === 'seeding') {
        el.textContent = 'Live / Seeding';
        el.className = 'status-chip status-success';
    } else {
        el.textContent = 'Preparing';
        el.className = 'status-chip status-pending';
    }
}
