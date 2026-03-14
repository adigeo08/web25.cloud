// @ts-check

function getElements() {
    return {
        container: document.getElementById('upload-progress'),
        bar: document.getElementById('upload-progress-bar'),
        text: document.getElementById('upload-progress-text')
    };
}

/**
 * @param {{label?: string, percent?: number | null, indeterminate?: boolean, state?: 'idle'|'running'|'success'|'error'}} options
 */
export function updateDeployProgress(options) {
    const { container, bar, text } = getElements();
    if (!container || !bar || !text) return;

    const state = options.state || 'running';
    container.classList.remove('hidden', 'progress-success', 'progress-error', 'progress-indeterminate');
    container.classList.add(`progress-${state}`);

    if (options.indeterminate) {
        container.classList.add('progress-indeterminate');
        bar.style.width = '100%';
    } else {
        container.classList.remove('progress-indeterminate');
        const safePercent = typeof options.percent === 'number' ? Math.max(0, Math.min(100, options.percent)) : 0;
        bar.style.width = `${safePercent}%`;
        bar.setAttribute('aria-valuenow', String(safePercent));
    }

    if (options.label) {
        text.textContent = options.label;
    }
}

export function hideDeployProgress() {
    const { container, bar } = getElements();
    if (!container || !bar) return;
    container.classList.add('hidden');
    container.classList.remove('progress-success', 'progress-error', 'progress-indeterminate', 'progress-running');
    bar.style.width = '0%';
}
