// @ts-check

export function createLockedBlockPlaceholder() {
    const wrapper = document.createElement('div');
    wrapper.className = 'web25-locked-block';
    wrapper.innerHTML = `
        <div style="font-weight:700; margin-bottom: 0.4rem;">🔒 Locked content</div>
        <button type="button" data-web25-import-token class="web25-import-token-btn">Import access token</button>
    `;
    return wrapper;
}
