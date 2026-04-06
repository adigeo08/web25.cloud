// @ts-check

export function renderIdentityBadge(state) {
    const node = document.getElementById('identity-badge');
    if (!node) return;

    if (!state.address) {
        node.textContent = 'Identity: anonymous';
        return;
    }

    const short = `${state.address.slice(0, 6)}...${state.address.slice(-4)}`;
    const passkeyIcon = state.passkeyProtected ? ' 🔐' : '';
    node.textContent = `Identity: ${state.identityType} (${short})${passkeyIcon}`;
}
