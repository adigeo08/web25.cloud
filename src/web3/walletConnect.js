// @ts-check

export function getWalletConnectProjectId() {
    const configured = window.WALLETCONNECT_PROJECT_ID || localStorage.getItem('walletconnect_project_id');
    if (configured) {
        return configured;
    }
    return null;
}

export function hasWalletConnectProjectId() {
    return Boolean(getWalletConnectProjectId());
}
