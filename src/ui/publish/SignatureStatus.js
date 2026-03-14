// @ts-check

export function renderSignatureStatus(signatureResult) {
    const container = document.getElementById('signature-status');
    if (!container) return;

    if (!signatureResult) {
        container.textContent = 'Signature pending';
        container.className = 'status-chip status-pending';
        return;
    }

    container.textContent = `Signature ready · ${signatureResult.signature.slice(0, 18)}...`;
    container.className = 'status-chip status-success';
}
