// @ts-check

export function bindPublishActions({ onSign, onPublish }) {
    const signBtn = document.getElementById('sign-publish-btn');
    const publishBtn = document.getElementById('publish-btn');
    const gofileMirror = /** @type {HTMLInputElement | null} */ (document.getElementById('deploy-gofile-mirror'));

    if (signBtn) signBtn.addEventListener('click', onSign);
    if (publishBtn) publishBtn.addEventListener('click', onPublish);

    // The mirror is the fallback transport, and a deployment that has one stays
    // reachable on a quiet swarm — so new deploys opt in by default. The
    // publisher can still explicitly uncheck it; nothing here re-enables the
    // option after user interaction.
    if (gofileMirror) gofileMirror.checked = true;

    // Keep the About copy aligned with the deploy default without duplicating
    // another large static section in index.html.
    const aboutCards = Array.from(document.querySelectorAll('.about-card'));
    const publishingCard = aboutCards.find((card) => card.querySelector('h3')?.textContent?.includes('Publishing:'));
    if (publishingCard && !publishingCard.querySelector('[data-gofile-default-note]')) {
        const note = document.createElement('p');
        note.dataset.gofileDefaultNote = 'true';
        note.innerHTML =
            'The optional GoFile mirror is <strong>preselected by default</strong> for new deploys because it is what keeps a site reachable when no peer answers. WEB25 loads in the order local cache → WebTorrent/P2P → GoFile: the swarm gets one 8-second attempt first, and the mirror only ever serves what that attempt could not. You can uncheck it before deployment.';
        publishingCard.appendChild(note);
    }
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
