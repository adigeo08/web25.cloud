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
