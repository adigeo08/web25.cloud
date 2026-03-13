// @ts-check

export function renderSignatureStatus(signatureResult) {
    const container = document.getElementById('signature-status');
    if (!container) return;

    if (!signatureResult) {
        container.textContent = 'Signature: pending';
        return;
    }

    container.textContent = `Signature: ${signatureResult.signature.slice(0, 18)}...`;
}
