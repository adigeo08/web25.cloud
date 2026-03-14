// @ts-check

export function bindAccessPanel({ onGenerateKey, onImportGrant, onExportPublicKey }) {
    const generateBtn = document.getElementById('generate-access-key-btn');
    if (generateBtn) generateBtn.addEventListener('click', onGenerateKey);

    const importBtn = document.getElementById('import-grant-btn');
    if (importBtn) importBtn.addEventListener('click', onImportGrant);

    const exportBtn = document.getElementById('export-access-key-btn');
    if (exportBtn) exportBtn.addEventListener('click', onExportPublicKey);
}


export function renderAccessPanel({ publicKey, grants = [] }) {
    const keyEl = document.getElementById('access-public-key');
    if (keyEl) keyEl.textContent = publicKey || 'No access key generated yet';

    const listEl = document.getElementById('access-grants-list');
    if (!listEl) return;

    if (!grants.length) {
        listEl.innerHTML = '<li>No tokens imported</li>';
        return;
    }

    listEl.innerHTML = grants
        .map((grant) => {
            const blocks = grant.blocks?.map((b) => `${b.blockId}@${b.epoch}`).join(', ') || 'none';
            return `<li><strong>${grant.siteId}</strong> · ${blocks}</li>`;
        })
        .join('');
}
