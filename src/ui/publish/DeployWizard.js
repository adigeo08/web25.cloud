// @ts-check

/**
 * Lightweight wizard UI layer for the Deploy tab.
 * Derives current step from existing deploy state and updates DOM accordingly.
 * Does NOT alter core deploy logic.
 */

/**
 * @typedef {'idle'|'disabled'|'pending'|'available'|'unavailable'} MirrorState
 * @typedef {{ hasFiles: boolean, hasSignature: boolean, hasDeployResult: boolean,
 *             isError?: boolean, mirrorState?: MirrorState }} DeployWizardState
 */

/** @type {NodeListOf<HTMLElement> | null} */
let stepChips = null;

/** @type {HTMLElement | null} */
let wizardNextEl = null;

/** @type {HTMLDetailsElement | null} */
let techDetails = null;

/** @type {NodeListOf<HTMLElement> | null} */
let screens = null;

/**
 * The screen the publisher asked to see ("Change files", "Deploy another"),
 * which holds only until the pipeline itself moves on to a different one.
 * @type {string | null}
 */
let manualScreen = null;

/** Screen derived from state on the previous update, to detect that move. */
let lastDerivedScreen = null;

const MIRROR_STEP = 6;
const LIVE_STEP = 7;

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
    screens = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#tab-publish [data-deploy-screen]'));
    manualScreen = null;
    lastDerivedScreen = null;

    // Screen navigation is presentation only: it never touches deploy state, so
    // a publisher can look back at the drop zone without losing a signature.
    document.querySelectorAll('#tab-publish [data-deploy-nav]').forEach((button) => {
        button.addEventListener('click', () => {
            manualScreen = button.getAttribute('data-deploy-nav');
            applyScreen(manualScreen);
        });
    });
}

/** Which of the three screens a pipeline step belongs to. */
function screenForStep(activeStep, hasDeployResult) {
    if (hasDeployResult) return 'live';
    if (activeStep >= 4) return 'sign';
    return 'upload';
}

function applyScreen(name) {
    if (!screens || screens.length === 0) return;
    screens.forEach((screen) => {
        const isActive = screen.getAttribute('data-deploy-screen') === name;
        screen.classList.toggle('is-active', isActive);
        // Hidden screens leave the accessibility tree and the tab order with
        // them, so nothing focusable sits behind the one on show.
        screen.toggleAttribute('inert', !isActive);
        screen.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    });
}

function setChipText(chip, selector, text) {
    const target = chip?.querySelector(selector);
    if (target) target.textContent = text;
}

/**
 * Update the wizard UI based on current deploy state.
 * Maps state to one of seven step chips and updates visual affordances.
 * @param {DeployWizardState} state
 */
export function updateDeployWizard(state) {
    if (!stepChips || stepChips.length === 0) return;

    const { hasFiles, hasSignature, hasDeployResult, isError = false, mirrorState = 'idle' } = state;
    const mirrored = mirrorState === 'available';

    // Determine active step (1-based, matching the 7 step chips)
    // 1 – Select  2 – Build  3 – Review  4 – Sign  5 – Deploy  6 – Mirror  7 – Live
    // Step 6 is optional: the torrent deployment is already live and seeding by
    // the time it runs, and it is skipped outright when the publisher did not
    // ask for a mirror.
    let activeStep;
    if (hasDeployResult) {
        activeStep = mirrorState === 'pending' ? MIRROR_STEP : LIVE_STEP;
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

    // The last chip only claims a mirror when there actually is one.
    const liveChip = stepChips[LIVE_STEP - 1];
    setChipText(liveChip, '.step-chip-text', mirrored ? '7. Live + mirrored' : '7. Live and seeding');

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
        } else if (hasFiles && hasSignature) {
            nextText = '▶ Next: Deploy your signed torrent to go live.';
        } else if (hasFiles) {
            nextText = '▶ Next: Sign your payload to authorize deployment.';
        } else {
            nextText = '▶ Next: Upload your website folder to stage files.';
        }
        wizardNextEl.textContent = nextText;
    }

    // Move to the screen this step belongs to. A publisher who stepped back
    // stays where they are until the pipeline itself advances.
    const derivedScreen = screenForStep(activeStep, hasDeployResult);
    if (derivedScreen !== lastDerivedScreen) {
        lastDerivedScreen = derivedScreen;
        manualScreen = null;
    }
    applyScreen(manualScreen || derivedScreen);

    // Auto-open technical details panel on error states
    if (techDetails && isError) {
        techDetails.open = true;
    }
}
