// @ts-check

import { createAuthState, AUTH_STATUS } from './AuthState.js';
import { connectExternalWallet, disconnectExternalWallet } from './ExternalWalletService.js';
import {
    getLocalWalletStatus,
    lockLocalWallet,
    registerLocalWallet,
    removeLocalWallet,
    unlockLocalWallet
} from './LocalWalletService.js';
import { renderAuthPanel } from '../ui/auth/AuthPanel.js';
import { bindConnectWallet } from '../ui/auth/ConnectWalletModal.js';
import { bindRegisterWallet } from '../ui/auth/RegisterWalletModal.js';
import { bindUnlockWallet } from '../ui/auth/UnlockWalletModal.js';
import { hideSeedPhrase, showSeedPhrase } from '../ui/auth/SeedPhraseScreen.js';

export default class AuthController {
    constructor(toast) {
        this.toast = toast;
        this.state = createAuthState();
    }

    async init() {
        await this.refreshLocalWalletState();

        bindConnectWallet(() => this.connectExternal());
        bindRegisterWallet(() => this.registerLocal());
        bindUnlockWallet(() => this.unlockLocal());

        const disconnectBtn = document.getElementById('disconnect-auth-btn');
        if (disconnectBtn) disconnectBtn.addEventListener('click', () => this.disconnect());

        const deleteBtn = document.getElementById('delete-local-wallet-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', () => this.deleteLocalWallet());

        const closeSeedBtn = document.getElementById('close-seed-screen-btn');
        if (closeSeedBtn) closeSeedBtn.addEventListener('click', () => hideSeedPhrase());

        this.render();
    }

    render() {
        renderAuthPanel(this.state);
    }

    async refreshLocalWalletState() {
        const localWallet = await getLocalWalletStatus();
        this.state.localWalletExists = localWallet.exists;
        this.state.localWalletUnlocked = localWallet.unlocked;

        if (localWallet.unlocked) {
            this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
            this.state.identityType = 'local';
            this.state.address = localWallet.address;
        } else if (localWallet.exists) {
            this.state.status = AUTH_STATUS.LOCAL_REGISTERED_LOCKED;
        }
    }

    async connectExternal() {
        try {
            const result = await connectExternalWallet();
            this.state.identityType = 'external';
            this.state.address = result.address;
            this.state.chainId = result.chainId;
            this.state.status = AUTH_STATUS.EXTERNAL_CONNECTED;
            this.render();
            this.toast.success(`Connected ${result.address}`, 'External wallet connected');
        } catch (err) {
            this.toast.error(err.message, 'Connection failed');
        }
    }

    async registerLocal() {
        try {
            const result = await registerLocalWallet();
            this.state.identityType = 'local';
            this.state.address = result.address;
            this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
            this.state.localWalletExists = true;
            this.state.localWalletUnlocked = true;
            showSeedPhrase(result.seedPhrase);
            this.render();
        } catch (err) {
            this.toast.error(err.message, 'Registration failed');
        }
    }

    async unlockLocal() {
        try {
            const result = await unlockLocalWallet();
            this.state.identityType = 'local';
            this.state.address = result.address;
            this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
            this.state.localWalletUnlocked = true;
            this.render();
        } catch (err) {
            this.toast.error(err.message, 'Unlock failed');
        }
    }

    async disconnect() {
        try {
            if (this.state.identityType === 'external') {
                await disconnectExternalWallet();
            }
            lockLocalWallet();
            this.state = createAuthState();
            await this.refreshLocalWalletState();
            this.render();
        } catch (err) {
            this.toast.error(err.message, 'Disconnect failed');
        }
    }

    async deleteLocalWallet() {
        const confirmed = window.confirm(
            'Are you sure you want to delete your local wallet? This action is irreversible — the wallet cannot be recovered without the seed phrase.'
        );
        if (!confirmed) return;
        try {
            await removeLocalWallet();
            this.state = createAuthState();
            this.render();
        } catch (err) {
            this.toast.error(err.message, 'Delete failed');
        }
    }

    getActiveIdentity() {
        return {
            identityType: this.state.identityType,
            address: this.state.address,
            chainId: this.state.chainId,
            status: this.state.status
        };
    }
}
