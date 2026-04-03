// @ts-check

/**
 * Lightweight wizard UI layer for the Deploy tab.
 * Derives current step from existing deploy state and updates DOM accordingly.
 * Does NOT alter core deploy logic.
 */

/**
 * @typedef {{ hasFiles: boolean, hasSignature: boolean, hasDeployResult: boolean }} DeployWizardState
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
        document.querySelector('#tab-publish .deploy-card details')
    );
}

/**
 * Update the wizard UI based on current deploy state.
 * Maps state to one of six step chips and updates visual affordances.
 * @param {DeployWizardState} state
 */
export function updateDeployWizard(state) {
    if (!stepChips || stepChips.length === 0) return;

    const { hasFiles, hasSignature, hasDeployResult } = state;

    // Derive active step (1-based, matching the 6 step chips)
    // 1 – Select files  2 – Build bundle  3 – Review  4 – Sign  5 – Deploy  6 – Live
    let activeStep;
    if (hasDeployResult) {
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

    // Update "Next suggested action" microcopy
    if (wizardNextEl) {
        let nextText;
        if (hasDeployResult) {
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
    if (techDetails) {
        const stageLabel = document.getElementById('deploy-stage-label');
        const stageText = stageLabel ? stageLabel.textContent || '' : '';
        const isErrorState =
            stageText.toLowerCase().includes('failed') ||
            stageText.toLowerCase().includes('blocked') ||
            stageText.toLowerCase().includes('error');
        if (isErrorState) {
            techDetails.open = true;
        }
    }
}
