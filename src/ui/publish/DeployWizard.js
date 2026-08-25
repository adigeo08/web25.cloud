// @ts-check

/**
 * Lightweight wizard UI layer for the Deploy tab.
 * Derives current step from existing deploy state and updates DOM accordingly.
 * Does NOT alter core deploy logic.
 */

/**
 * @typedef {{ hasFiles: boolean, hasSignature: boolean, hasDeployResult: boolean,
 *             registryState?: 'idle'|'signing'|'publishing'|'published'|'failed'|'skipped',
 *             isError?: boolean }} DeployWizardState
 */

/** @type {NodeListOf<HTMLElement> | null} */
let stepChips = null;

/** @type {HTMLElement | null} */
let wizardNextEl = null;

/** @type {HTMLDetailsElement | null} */
let techDetails = null;

/**
 * Initialise wizard: cache DOM references.
 * Call once after DOM is ready.
 */
export function initDeployWizard() {
    stepChips = /** @type {NodeListOf<HTMLElement>} */ (
        document.querySelectorAll('#tab-publish .step-chip')
    );
    wizardNextEl = document.getElementById('deploy-wizard-next');
    techDetails = /** @type {HTMLDetailsElement | null} */ (
        document.getElementById('deploy-tech-details')
    );
}

/**
 * Update the wizard UI based on current deploy state.
 * Maps state to one of six step chips and updates visual affordances.
 * @param {DeployWizardState} state
 */
export function updateDeployWizard(state) {
    if (!stepChips || stepChips.length === 0) return;

    const { hasFiles, hasSignature, hasDeployResult, registryState = 'idle', isError = false } = state;

    // Determine active step (1-based, matching the 7 step chips)
    // 1 – Select files  2 – Build bundle  3 – Review  4 – Sign (EVM/.torrentchain)
    // 5 – Deploy  6 – Live and seeding  7 – Publish to NosNS
    // `skipped` means no NosNS event was ever created (a locked wallet, say):
    // nothing is in progress and there is nothing to retry, so the wizard should
    // not advance onto — or highlight — the NosNS step.
    const registryStarted = registryState !== 'idle' && registryState !== 'skipped';
    let activeStep;
    if (hasDeployResult && registryStarted) {
        activeStep = 7;
    } else if (hasDeployResult) {
        activeStep = 6;
    } else if (hasFiles && hasSignature) {
        activeStep = 5;
    } else if (hasFiles) {
        activeStep = 4; // files staged → guide user to sign (covers bundle + review + sign)
    } else {
        activeStep = 1;
    }

    // Apply visual state to each chip
    stepChips.forEach((chip, index) => {
        const chipStep = index + 1;
        chip.classList.remove('step-active', 'step-done', 'step-locked');
        chip.removeAttribute('aria-current');

        if (chipStep === activeStep) {
            chip.classList.add('step-active');
            chip.setAttribute('aria-current', 'step');
        } else if (chipStep < activeStep) {
            chip.classList.add('step-done');
        } else {
            chip.classList.add('step-locked');
        }
    });

    // The NosNS step is the only one that can complete *and* fail without
    // invalidating the deployment, so it gets its own visual state.
    if (stepChips.length >= 7) {
        const registryChip = stepChips[6];
        if (registryState === 'published') {
            registryChip.classList.remove('step-active', 'step-locked');
            registryChip.classList.add('step-done');
        } else if (registryState === 'failed') {
            registryChip.classList.remove('step-done', 'step-locked');
            registryChip.classList.add('step-active');
        } else if (registryState === 'skipped') {
            registryChip.classList.remove('step-active', 'step-done');
            registryChip.classList.add('step-locked');
        }
    }

    // Update "Next suggested action" microcopy
    if (wizardNextEl) {
        let nextText;
        if (hasDeployResult && registryState === 'published') {
            nextText = '🎉 Live and seeding, and listed in the NosNS directory — share the link below!';
        } else if (hasDeployResult && registryState === 'failed') {
            nextText = '🎉 Live and seeding. The NosNS entry did not publish — you can retry it below.';
        } else if (hasDeployResult && registryState === 'skipped') {
            nextText = '🎉 Your site is live and seeding. No NosNS entry was created for it.';
        } else if (hasDeployResult) {
            nextText = '🎉 Your site is live and seeding — share the link below!';
        } else if (hasFiles && hasSignature) {
            nextText = '▶ Next: Deploy your signed torrent to go live.';
        } else if (hasFiles) {
            nextText = '▶ Next: Sign your payload to authorize deployment.';
        } else {
            nextText = '▶ Next: Upload your website folder to stage files.';
        }
        wizardNextEl.textContent = nextText;
    }

    // Auto-open technical details panel on error states
    if (techDetails && isError) {
        techDetails.open = true;
    }
}
