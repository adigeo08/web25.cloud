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
            'https://esm.sh/viem@2.22.21/chains',
            'https://cdn.jsdelivr.net/npm/viem@2.22.21/chains/+esm'
        ]);
        const connectors = await importFromAny([
            'https://esm.sh/@wagmi/connectors@5.1.8',
            'https://cdn.jsdelivr.net/npm/@wagmi/connectors@5.1.8/+esm'
        ]);

        const projectId = getWalletConnectProjectId();
        const config = core.createConfig({
            chains: [chains.mainnet],
            connectors: [
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
            ],
            transports: {
                [chains.mainnet.id]: core.http()
            }
        });

        cached = { core, config };
    }

    return cached;
}
