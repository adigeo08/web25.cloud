// @ts-check

import { createAuthState, AUTH_STATUS } from './AuthState.js';
import {
    clearLocalWalletSession,
    getLocalWalletStatus,
    registerLocalWallet,
    removeLocalWallet,
    unlockLocalWallet,
    registerLocalWalletFromSeed,
    restoreSessionFromSW
} from './LocalWalletService.js';
import { addAlternatePasskey, clearBiometricSession, getLocalWalletRecord, passkeySupported } from './SecureKeyStore.js';
import { renderAuthPanel } from '../ui/auth/AuthPanel.js';
import { bindRegisterWallet } from '../ui/auth/RegisterWalletModal.js';
import { bindUnlockWallet } from '../ui/auth/UnlockWalletModal.js';
import { bindRecoverWallet } from '../ui/auth/RecoverWalletModal.js';
import { hideSeedPhrase, showSeedPhrase } from '../ui/auth/SeedPhraseScreen.js';

export default class AuthController {
    constructor(toast, options = {}) {
        this.toast = toast;
        this.state = createAuthState();
        this.listeners = new Set();
        this.onDisconnect = typeof options.onDisconnect === 'function' ? options.onDisconnect : null;
    }

    async init() {
        await restoreSessionFromSW();
        await this.refreshLocalWalletState();

        bindRegisterWallet(() => this.registerLocal());
        bindUnlockWallet(() => this.unlockLocal());
        bindRecoverWallet((seedPhrase) => this.recoverLocal(seedPhrase));

        const lockDisconnectBtn = document.getElementById('lock-disconnect-auth-btn');
        if (lockDisconnectBtn) lockDisconnectBtn.addEventListener('click', () => this.lockAndDisconnect());

        const deleteBtn = document.getElementById('delete-local-wallet-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', () => this.deleteLocalWallet());

        const closeSeedBtn = document.getElementById('close-seed-screen-btn');
        if (closeSeedBtn) closeSeedBtn.addEventListener('click', () => hideSeedPhrase());

        const addPasskeyBtn = document.getElementById('add-passkey-btn');
        if (addPasskeyBtn) addPasskeyBtn.addEventListener('click', () => this.addAlternatePasskey());

        const migrateBtn = document.getElementById('migrate-wallet-btn');
        if (migrateBtn) migrateBtn.addEventListener('click', () => this.migrateFromLegacy());

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
        this.state.passkeyProtected = Boolean(localWallet.passkeyProtected);

        if (localWallet.exists && localWallet.address) {
            this.state.identityType = 'local';
            this.state.address = localWallet.address;
        }

        if (!passkeySupported()) {
            this.state.status = AUTH_STATUS.PASSKEY_NOT_SUPPORTED;
            return;
        }

        if (localWallet.needsMigration) {
            this.state.status = AUTH_STATUS.LOCAL_NEEDS_MIGRATION;
            return;
        }

        if (localWallet.unlocked) {
            this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
            return;
        }
        if (localWallet.exists) {
            this.state.status = AUTH_STATUS.LOCAL_REGISTERED_LOCKED;
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
            this.state.passkeyProtected = passkeySupported();
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
            this.state.passkeyProtected = passkeySupported();
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

    async addAlternatePasskey() {
        try {
            const record = await getLocalWalletRecord();
            if (!record?.credentialId) {
                throw new Error('No passkey identity found for the current wallet.');
            }
            await addAlternatePasskey(record.credentialId);
            this.toast.success('Alternate passkey added for this wallet.', 'Passkey added');
        } catch (err) {
            this.toast.error(err.message, 'Passkey setup failed');
        }
    }

    async migrateFromLegacy() {
        const input = document.getElementById('migration-seed-input');
        if (!(input instanceof HTMLInputElement)) {
            this.toast.error('Migration input is missing from UI.', 'Migration failed');
            return;
        }
        const seedPhrase = input.value.trim();
        if (!seedPhrase) {
            this.toast.error('Please provide your seed phrase to migrate.', 'Migration required');
            return;
        }

        try {
            await removeLocalWallet();
            const result = await registerLocalWalletFromSeed(seedPhrase);
            input.value = '';
            this.state.identityType = 'local';
            this.state.address = result.address;
            this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
            this.state.localWalletExists = true;
            this.state.localWalletUnlocked = true;
            this.state.passkeyProtected = passkeySupported();
            this.render();
            this.notify();
            this.toast.success('Legacy wallet upgraded to passkey protection.', 'Migration complete');
        } catch (err) {
            this.toast.error(err.message, 'Migration failed');
        }
    }

    async lockAndDisconnect() {
        try {
            clearBiometricSession();
            await clearLocalWalletSession();
            if (this.onDisconnect) {
                await this.onDisconnect();
            }
            this.state = createAuthState();
            await this.refreshLocalWalletState();
            this.render();
            this.notify();
            this.toast.info('Local wallet locked and disconnected.', 'Disconnected');
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
