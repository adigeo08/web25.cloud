// @ts-check

import { getWagmiCore } from '../web3/wagmiConfig.js';

export async function connectExternalWallet() {
    const { core, config } = await getWagmiCore();
    const connectors = core.getConnectors(config);
    if (!connectors.length) {
        throw new Error('No wallet connectors available');
    }

    const result = await core.connect(config, { connector: connectors[0] });
    return {
        address: result.accounts?.[0] || null,
        chainId: result.chainId || 1
    };
}

export async function disconnectExternalWallet() {
    const { core, config } = await getWagmiCore();
    await core.disconnect(config);
}

export async function signWithExternalWallet(message) {
    const { core, config } = await getWagmiCore();
    return core.signMessage(config, { message });
}
