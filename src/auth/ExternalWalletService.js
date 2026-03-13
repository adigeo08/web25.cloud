// @ts-check

import { getWagmiCore } from '../web3/wagmiConfig.js';

async function getWalletConnectConnector(core, config) {
    const connectors = core.getConnectors(config);
    const connector = connectors.find((item) => item.id === 'walletConnect') || connectors[0];
    if (!connector) {
        throw new Error('WalletConnect connector is unavailable');
    }
    return connector;
}

export async function connectExternalWallet() {
    const { core, config } = await getWagmiCore();
    const connector = await getWalletConnectConnector(core, config);
    const result = await core.connect(config, { connector });
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
    const account = core.getAccount(config);
    if (!account?.address) {
        throw new Error('External wallet is not connected');
    }
    return core.signMessage(config, { account: account.address, message });
}
