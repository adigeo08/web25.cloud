// @ts-check

import { getWalletConnectProjectId } from './walletConnect.js';

let cached;

export async function getWagmiCore() {
    if (!cached) {
        const core = await import('https://esm.sh/@wagmi/core@2.13.8');
        const chains = await import('https://esm.sh/@wagmi/core/chains@2.13.8');
        const connectors = await import('https://esm.sh/@wagmi/connectors@5.1.8');

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
