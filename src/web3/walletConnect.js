// @ts-check

export function getWalletConnectProjectId() {
    const configured = window.WALLETCONNECT_PROJECT_ID || localStorage.getItem('walletconnect_project_id');
    if (configured) {
        return configured;
    }

    throw new Error(
        'Missing WalletConnect project id. Set window.WALLETCONNECT_PROJECT_ID or localStorage.walletconnect_project_id.'
    );
}
