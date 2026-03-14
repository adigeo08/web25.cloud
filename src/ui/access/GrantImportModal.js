// @ts-check

export function bindGrantImport(onImport) {
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById('grant-import-input'));
    const triggerButtons = document.querySelectorAll('[data-web25-import-token], #import-grant-btn');

    const openPicker = () => input?.click();
    triggerButtons.forEach((btn) => btn.addEventListener('click', openPicker));

    if (!input) return;
    input.addEventListener('change', async (event) => {
        const target = /** @type {HTMLInputElement} */ (event.target);
        const file = target.files?.[0];
        if (!file) return;
        const raw = await file.text();
        const json = JSON.parse(raw);
        await onImport(json);
        target.value = '';
    });
}
