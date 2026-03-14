// @ts-check

import { getWalletConnectProjectId } from './walletConnect.js';

let cached;

async function importFromAny(urls) {
    let lastError = null;
    for (const url of urls) {
        try {
            return await import(url);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('Failed to import module');
}

export async function getWagmiCore() {
    if (!cached) {
        const core = await importFromAny([
            'https://esm.sh/@wagmi/core@2.13.8',
            'https://cdn.jsdelivr.net/npm/@wagmi/core@2.13.8/+esm'
        ]);
        const chains = await importFromAny([
            'https://esm.sh/@wagmi/core@2.13.8/chains',
            'https://cdn.jsdelivr.net/npm/@wagmi/core@2.13.8/chains/+esm'
        ]);
        const connectors = await importFromAny([
            'https://esm.sh/@wagmi/connectors@5.1.8',
            'https://cdn.jsdelivr.net/npm/@wagmi/connectors@5.1.8/+esm'
        ]);

        const projectId = getWalletConnectProjectId();
        if (!projectId) {
            throw new Error(
                'WalletConnect project ID not configured. Set window.WALLETCONNECT_PROJECT_ID or localStorage walletconnect_project_id.'
            );
        }

        const wagmiConnectors = [
            connectors.walletConnect({
                projectId,
                showQrModal: true,
                metadata: {
                    name: 'Web25.Cloud',
                    description: 'Torrent publish identity',
                    url: window.location.origin,
                    icons: []
                }
            })
        ];

        const config = core.createConfig({
            chains: [chains.mainnet],
            connectors: wagmiConnectors,
            transports: {
                [chains.mainnet.id]: core.http()
            }
        });

        cached = { core, config };
    }

    return cached;
}
