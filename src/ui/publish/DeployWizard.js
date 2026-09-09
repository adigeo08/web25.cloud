// @ts-check

/**
 * Lightweight wizard UI layer for the Deploy tab.
 * Derives current step from existing deploy state and updates DOM accordingly.
 * Does NOT alter core deploy logic.
 */

/**
 * @typedef {'idle'|'disabled'|'pending'|'available'|'unavailable'} MirrorState
 * @typedef {{ hasFiles: boolean, hasSignature: boolean, hasDeployResult: boolean,
 *             isError?: boolean, mirrorState?: MirrorState,
 *             inProtectStep?: boolean, protectedCount?: number }} DeployWizardState
 */

/** @type {NodeListOf<HTMLElement> | null} */
let stepChips = null;

/** @type {HTMLElement | null} */
let wizardNextEl = null;

/** @type {HTMLDetailsElement | null} */
let techDetails = null;

const PROTECT_STEP = 2;
const MIRROR_STEP = 7;
const LIVE_STEP = 8;

/** The mirror step is optional, so it says what became of it in words. */
const MIRROR_NOTES = {
    idle: 'Optional',
    disabled: 'Skipped',
    pending: 'In progress',
    available: 'Created',
    unavailable: 'Not created'
};

/**
 * Initialise wizard: cache DOM references.
 * Call once after DOM is ready.
 */
export function initDeployWizard() {
    stepChips = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#tab-publish .step-chip'));
    wizardNextEl = document.getElementById('deploy-wizard-next');
    techDetails = /** @type {HTMLDetailsElement | null} */ (document.getElementById('deploy-tech-details'));
}

function setChipText(chip, selector, text) {
    const target = chip?.querySelector(selector);
    if (target) target.textContent = text;
}

/**
 * Update the wizard UI based on current deploy state.
 * Maps state to one of eight step chips and updates visual affordances.
 * @param {DeployWizardState} state
 */
export function updateDeployWizard(state) {
    if (!stepChips || stepChips.length === 0) return;

    const { hasFiles, hasSignature, hasDeployResult, isError = false, mirrorState = 'idle' } = state;
    const mirrored = mirrorState === 'available';

    // Determine active step (1-based, matching the 8 step chips)
    // 1 – Select  2 – Preview & Protect  3 – Build  4 – Review  5 – Sign
    // 6 – Deploy  7 – Mirror  8 – Live
    // Step 2 is optional in effect: a publisher who protects nothing passes
    // straight through it, and steps 3 onward are exactly the flow that shipped
    // before protected assets existed.
    // Step 7 is optional too: the torrent deployment is already live and seeding
    // by the time it runs, and it is skipped outright when the publisher did not
    // ask for a mirror.
    const { inProtectStep = false } = state;

    let activeStep;
    if (hasDeployResult) {
        activeStep = mirrorState === 'pending' ? MIRROR_STEP : LIVE_STEP;
    } else if (inProtectStep) {
        activeStep = PROTECT_STEP;
    } else if (hasFiles && hasSignature) {
        activeStep = 6;
    } else if (hasFiles) {
        activeStep = 5; // files staged → guide user to sign (covers bundle + review + sign)
    } else {
        activeStep = 1;
    }

    // Apply visual state to each chip
    stepChips.forEach((chip, index) => {
        const chipStep = index + 1;
        chip.classList.remove('is-current', 'step-active', 'step-done', 'step-locked', 'step-skipped', 'step-failed');
        chip.removeAttribute('aria-current');

        if (chipStep === MIRROR_STEP && chipStep !== activeStep) {
            // Never show an optional step the publisher declined as completed,
            // and never show a failed mirror as a blocked deployment.
            if (mirrorState === 'disabled') chip.classList.add('step-skipped');
            else if (mirrorState === 'unavailable') chip.classList.add('step-failed');
            else if (chipStep < activeStep) chip.classList.add('step-done');
            else chip.classList.add('step-locked');
        } else if (chipStep === activeStep) {
            chip.classList.add('step-active', 'is-current');
            chip.setAttribute('aria-current', 'step');
        } else if (chipStep < activeStep) {
            chip.classList.add('step-done');
        } else {
            chip.classList.add('step-locked');
        }
    });

    const mirrorChip = stepChips[MIRROR_STEP - 1];
    setChipText(mirrorChip, '.step-chip-note', MIRROR_NOTES[mirrorState] || MIRROR_NOTES.idle);

    // The protect step says what it actually did, so "nothing protected" reads
    // as a deliberate choice rather than a step that failed.
    const protectChip = stepChips[PROTECT_STEP - 1];
    const protectedCount = Number(state.protectedCount || 0);
    if (protectChip) {
        let protectNote = 'Optional';
        if (inProtectStep) protectNote = 'In progress';
        else if (activeStep > PROTECT_STEP) {
            protectNote = protectedCount > 0 ? `${protectedCount} protected` : 'Nothing protected';
        }
        setChipText(protectChip, '.step-chip-note', protectNote);
    }

    // The last chip only claims a mirror when there actually is one.
    const liveChip = stepChips[LIVE_STEP - 1];
    setChipText(liveChip, '.step-chip-text', mirrored ? '8. Live + mirrored' : '8. Live and seeding');

    // Update "Next suggested action" microcopy
    if (wizardNextEl) {
        let nextText;
        if (hasDeployResult && mirrorState === 'pending') {
            nextText = '⏳ Your site is live and seeding. Finishing the optional fallback mirror…';
        } else if (hasDeployResult && mirrored) {
            nextText = '🎉 Live, seeding, and mirrored — share the link below!';
        } else if (hasDeployResult && mirrorState === 'unavailable') {
            nextText = '🎉 Your site is live and seeding. The optional mirror was not created — share the link below!';
        } else if (hasDeployResult) {
            nextText = '🎉 Your site is live and seeding — share the link below!';
        } else if (inProtectStep) {
            nextText = '▶ Select any text you want to protect, then continue to Deploy.';
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
