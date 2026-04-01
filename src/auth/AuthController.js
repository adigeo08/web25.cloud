// @ts-check

import { createAuthState, AUTH_STATUS } from './AuthState.js';
import {
    getLocalWalletStatus,
    lockLocalWallet,
    registerLocalWallet,
    removeLocalWallet,
    unlockLocalWallet,
    registerLocalWalletFromSeed
} from './LocalWalletService.js';
import { renderAuthPanel } from '../ui/auth/AuthPanel.js';
import { bindRegisterWallet } from '../ui/auth/RegisterWalletModal.js';
import { bindUnlockWallet } from '../ui/auth/UnlockWalletModal.js';
import { bindRecoverWallet } from '../ui/auth/RecoverWalletModal.js';
import { hideSeedPhrase, showSeedPhrase } from '../ui/auth/SeedPhraseScreen.js';

export default class AuthController {
    constructor(toast) {
        this.toast = toast;
        this.state = createAuthState();
        this.listeners = new Set();
    }

    async init() {
        await this.refreshLocalWalletState();

        bindRegisterWallet(() => this.registerLocal());
        bindUnlockWallet(() => this.unlockLocal());
        bindRecoverWallet((seedPhrase) => this.recoverLocal(seedPhrase));

        const disconnectBtn = document.getElementById('disconnect-auth-btn');
        if (disconnectBtn) disconnectBtn.addEventListener('click', () => this.disconnect());

        const deleteBtn = document.getElementById('delete-local-wallet-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', () => this.deleteLocalWallet());

        const closeSeedBtn = document.getElementById('close-seed-screen-btn');
        if (closeSeedBtn) closeSeedBtn.addEventListener('click', () => hideSeedPhrase());

        this.render();
        this.notify();
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        this.listeners.forEach((listener) => listener(this.state));
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
            return;
        } else if (localWallet.exists) {
            try {
                const result = await unlockLocalWallet();
                this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
                this.state.identityType = 'local';
                this.state.address = result.address;
                this.state.localWalletUnlocked = true;
            } catch (_err) {
                this.state.status = AUTH_STATUS.LOCAL_REGISTERED_LOCKED;
            }
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
            this.toast.warning(
                'This local wallet is for website signing only. Do NOT use it for deposits or storing funds.',
                'Security warning',
                9000
            );
            try {
                await navigator.clipboard.writeText(result.seedPhrase);
                this.toast.success('Seed phrase copied to clipboard automatically.', 'Seed copied');
            } catch (_) {
                this.toast.info('Could not auto-copy seed phrase. Please copy it manually now.', 'Clipboard unavailable');
            }
            this.render();
            this.notify();
        } catch (err) {
            this.toast.error(err.message, 'Registration failed');
        }
    }

    async recoverLocal(seedPhrase) {
        try {
            const result = await registerLocalWalletFromSeed(seedPhrase);
            this.state.identityType = 'local';
            this.state.address = result.address;
            this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
            this.state.localWalletExists = true;
            this.state.localWalletUnlocked = true;
            this.render();
            this.notify();
            this.toast.success(`Recovered ${result.address}`, 'Local wallet recovered');
            return true;
        } catch (err) {
            this.toast.error(err.message, 'Recovery failed');
            return false;
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
            this.notify();
        } catch (err) {
            this.toast.error(err.message, 'Unlock failed');
        }
    }

    async disconnect() {
        try {
            lockLocalWallet();
            this.state = createAuthState();
            await this.refreshLocalWalletState();
            this.render();
            this.notify();
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
            this.notify();
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
