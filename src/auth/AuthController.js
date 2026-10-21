// @ts-check

import { createAuthState, AUTH_STATUS } from './AuthState.js';
import {
    clearLocalWalletSession,
    destroyLocalWalletSession,
    getLocalWalletNostrIdentity,
    getLocalWalletPublicKey,
    getLocalWalletStatus,
    onWalletLocked,
    registerLocalWallet,
    removeLocalWallet,
    unlockLocalWallet,
    registerLocalWalletFromSeed,
    seedPhraseMatchesLocalWallet
} from './LocalWalletService.js';
import { addAlternatePasskey, getLocalWalletRecord, passkeySupported } from './SecureKeyStore.js';
import {
    consumeInterruptedSession,
    markSessionLocked,
    markSessionUnlocked,
    readResumeHint
} from './SessionResumeHint.js';
import {
    clearNostrIdentityPreference,
    isNostrIdentityEnabled,
    setNostrIdentityEnabled
} from '../nostr/NostrIdentityPreference.js';
import { renderAuthPanel } from '../ui/auth/AuthPanel.js';
import { bindRegisterWallet } from '../ui/auth/RegisterWalletModal.js';
import { bindUnlockWallet } from '../ui/auth/UnlockWalletModal.js';
import { bindRecoverWallet } from '../ui/auth/RecoverWalletModal.js';
import { bindSeedPhraseScreen, hideSeedPhrase, showSeedPhrase } from '../ui/auth/SeedPhraseScreen.js';
import { clearSeedBackupPending, markSeedBackupPending, readSeedBackupPending } from './SeedBackupState.js';

/** The wallet operations the controller drives; replaceable in tests. */
const LOCAL_WALLET = {
    clearLocalWalletSession,
    getLocalWalletNostrIdentity,
    getLocalWalletPublicKey,
    getLocalWalletRecord,
    getLocalWalletStatus,
    registerLocalWallet,
    registerLocalWalletFromSeed,
    removeLocalWallet,
    seedPhraseMatchesLocalWallet,
    unlockLocalWallet
};

export default class AuthController {
    /**
     * @param {any} toast
     * @param {{ onDisconnect?: Function, wallet?: Partial<typeof LOCAL_WALLET> }} [options] `wallet`
     *   stands in for the signing worker and passkey vault in tests
     */
    constructor(toast, options = {}) {
        this.toast = toast;
        this.state = createAuthState();
        this.listeners = new Set();
        this.onDisconnect = typeof options.onDisconnect === 'function' ? options.onDisconnect : null;
        this.wallet = { ...LOCAL_WALLET, ...(options.wallet || {}) };
    }

    async init() {
        // The signing worker starts locked on every page load: a refresh no
        // longer restores a session, because no component outside the worker
        // ever holds the key.
        onWalletLocked(() => {
            void this.handleWorkerLock();
        });
        // Read before anything renders: the unlock screen is the one place
        // where "you were signed in a moment ago" is worth saying out loud.
        this.state.resumeHint = readResumeHint();
        await this.refreshLocalWalletState();

        bindRegisterWallet(() => this.registerLocal());
        bindUnlockWallet(() => this.unlockLocal());
        bindRecoverWallet((seedPhrase) => this.recoverLocal(seedPhrase));

        const lockDisconnectBtn = document.getElementById('lock-disconnect-auth-btn');
        if (lockDisconnectBtn) lockDisconnectBtn.addEventListener('click', () => this.lockAndDisconnect());

        const deleteBtn = document.getElementById('delete-local-wallet-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', () => this.deleteLocalWallet());

        bindSeedPhraseScreen({
            onConfirm: () => this.confirmSeedBackup(),
            onCopyResult: (copied) => {
                if (copied) this.toast.success('Recovery phrase copied to clipboard.', 'Copied');
                else this.toast.error('Could not copy. Download the file or write the words down.', 'Copy failed');
            }
        });

        const resetBtn = document.getElementById('reset-unconfirmed-wallet-btn');
        if (resetBtn) resetBtn.addEventListener('click', () => this.resetUnconfirmedWallet());

        const addPasskeyBtn = document.getElementById('add-passkey-btn');
        if (addPasskeyBtn) addPasskeyBtn.addEventListener('click', () => this.addAlternatePasskey());

        const migrateBtn = document.getElementById('migrate-wallet-btn');
        if (migrateBtn) migrateBtn.addEventListener('click', () => this.migrateFromLegacy());

        const addNostrBtn = document.getElementById('add-nostr-identity-btn');
        if (addNostrBtn) addNostrBtn.addEventListener('click', () => this.setNostrIdentityEnabled(true));

        const deleteNostrBtn = document.getElementById('delete-nostr-identity-btn');
        if (deleteNostrBtn) deleteNostrBtn.addEventListener('click', () => this.setNostrIdentityEnabled(false));

        this.render();
        // The notice is on screen now, so the flag has done its job: it says
        // "the page you just loaded ended a live session", which is not true of
        // any later load. Put it down, keeping the remembered tab.
        if (this.state.resumeHint?.wasUnlocked) consumeInterruptedSession();
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

    /** Worker-side TTL expiry or crash: drop back to the locked UI state. */
    async handleWorkerLock() {
        if (this.state.seedBackupPending) {
            // Nobody was signed in yet, so there is no session to announce:
            // the backup itself is what was interrupted.
            this.abandonSeedBackup();
        } else {
            // The session ended without the user asking, so the unlock screen
            // says so — the same sentence a reload earns. This one is about the
            // page that is open, so it is set here rather than read back from a
            // flag that has already been consumed.
            this.state.resumeHint = { ...(this.state.resumeHint || { tab: '', savedAt: Date.now() }), wasUnlocked: true };
        }
        await this.refreshLocalWalletState();
        this.render();
        this.notify();
    }

    /**
     * The backup step ended before it was confirmed (the worker locked under
     * it). The phrase leaves the page; the persisted flag stays, so the wall
     * shows the interrupted-onboarding notice and its recover/reset paths.
     */
    abandonSeedBackup() {
        hideSeedPhrase();
        this.state.seedBackupPending = false;
        this.toast.warning(
            'The wallet locked before your recovery phrase was confirmed. Recover it with the words you saved, or delete it and start over.',
            'Backup not confirmed',
            9000
        );
    }

    async refreshLocalWalletState() {
        const localWallet = await this.wallet.getLocalWalletStatus();

        // A backup flag without a wallet is left over from a creation that
        // never finished, or a wallet deleted elsewhere: nothing to warn about.
        if (!localWallet.exists) clearSeedBackupPending();
        this.state.seedBackupInterrupted = Boolean(
            localWallet.exists && !this.state.seedBackupPending && readSeedBackupPending()
        );
        // An unconfirmed wallet never keeps a live session outside its backup
        // step, however the worker came to be unlocked.
        if (this.state.seedBackupInterrupted && localWallet.unlocked) {
            await this.wallet.clearLocalWalletSession();
            localWallet.unlocked = false;
        }

        this.state.localWalletExists = localWallet.exists;
        this.state.localWalletUnlocked = localWallet.unlocked;
        this.state.passkeyProtected = Boolean(localWallet.passkeyProtected);
        this.state.publicKey = localWallet.unlocked ? await this.wallet.getLocalWalletPublicKey() : null;
        await this.refreshNostrIdentity(localWallet.unlocked);

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

    /**
     * Pull the Nostr view of the wallet key. Derived from the same secp256k1
     * key inside the worker; public material only.
     * @param {boolean} unlocked
     */
    async refreshNostrIdentity(unlocked) {
        this.state.nostrEnabled = this.state.address ? isNostrIdentityEnabled(this.state.address) : true;

        if (!unlocked || !this.state.nostrEnabled) {
            this.state.nostrPublicKey = null;
            this.state.npub = null;
            return;
        }
        const nostrIdentity = await this.wallet.getLocalWalletNostrIdentity();
        this.state.nostrPublicKey = nostrIdentity?.nostrPublicKey || null;
        this.state.npub = nostrIdentity?.npub || null;
    }

    /**
     * Add or remove this identity's Nostr reachability.
     *
     * There is no second key to create or destroy: the Nostr address is the x
     * coordinate of the wallet key, so removing it takes the identity off the
     * relays and out of the UI, and adding it back yields the same `npub`.
     *
     * @param {boolean} enabled
     */
    async setNostrIdentityEnabled(enabled) {
        if (!this.state.address) {
            this.toast.warning('Unlock your wallet first.', 'Nostr identity');
            return false;
        }

        setNostrIdentityEnabled(this.state.address, enabled);
        await this.refreshNostrIdentity(Boolean(this.state.localWalletUnlocked));
        this.render();
        this.notify();

        if (enabled) {
            this.toast.success('Your Nostr address is active. Others can now message you.', 'Nostr identity added');
        } else {
            this.toast.info(
                'Nostr messaging is off and your inbox is unsubscribed. Adding it back restores the same address.',
                'Nostr identity removed'
            );
        }
        return true;
    }

    /** One place to record that a live session exists in this page. */
    rememberUnlockedSession() {
        markSessionUnlocked();
        this.state.resumeHint = readResumeHint();
    }

    /**
     * Create a wallet, then hold the user on the recovery phrase backup step.
     *
     * The worker is unlocked when this returns, but the session is not signed
     * in: `seedBackupPending` keeps every signed-in surface closed until
     * `confirmSeedBackup` runs.
     */
    async registerLocal() {
        if (this.registering || this.state.localWalletExists || this.state.seedBackupPending) return;
        this.registering = true;
        const registerBtn = document.getElementById('register-wallet-btn');
        if (registerBtn instanceof HTMLButtonElement) registerBtn.disabled = true;
        // Set before the wallet exists, so a page that dies at any point after
        // creation still knows the phrase was never acknowledged.
        markSeedBackupPending();
        try {
            const result = await this.wallet.registerLocalWallet();
            this.state.publicKey = await this.wallet.getLocalWalletPublicKey();
            await this.refreshNostrIdentity(true);
            this.state.identityType = 'local';
            this.state.address = result.address;
            this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
            this.state.localWalletExists = true;
            this.state.localWalletUnlocked = true;
            this.state.passkeyProtected = passkeySupported();
            this.state.seedBackupPending = true;
            this.state.seedBackupInterrupted = false;
            showSeedPhrase(result.seedPhrase);
            this.render();
            this.notify();
        } catch (err) {
            // Only a wallet that never reached storage may forget the flag. One
            // saved before the failure has a phrase nobody saw, so it keeps the
            // interrupted-onboarding notice and its recover/reset paths.
            let persisted = true;
            try {
                persisted = Boolean(await this.wallet.getLocalWalletRecord());
            } catch (_) {
                // Unknown: keep the flag; a later read without a wallet clears it.
            }
            if (!persisted) clearSeedBackupPending();
            this.toast.error(err.message, 'Registration failed');
            if (persisted) {
                try {
                    await this.refreshLocalWalletState();
                } catch (_) {
                    this.state.localWalletExists = true;
                    this.state.seedBackupInterrupted = true;
                }
                this.render();
                this.notify();
            }
        } finally {
            this.registering = false;
            if (registerBtn instanceof HTMLButtonElement) registerBtn.disabled = false;
        }
    }

    /**
     * The user has saved the phrase: finish onboarding and sign them in — but
     * only into a session that still exists. A worker that locked under the
     * backup screen makes this an interrupted onboarding instead.
     * @returns {Promise<boolean>} whether onboarding completed
     */
    async confirmSeedBackup() {
        if (!this.state.seedBackupPending || this.confirming) return false;
        this.confirming = true;
        try {
            let unlocked = false;
            try {
                unlocked = Boolean((await this.wallet.getLocalWalletStatus()).unlocked);
            } catch (_) {
                unlocked = false;
            }
            if (!this.state.seedBackupPending) return false;

            if (!unlocked) {
                this.abandonSeedBackup();
                await this.refreshLocalWalletState();
                this.render();
                this.notify();
                return false;
            }

            hideSeedPhrase();
            clearSeedBackupPending();
            this.state.seedBackupPending = false;
            this.state.seedBackupInterrupted = false;
            this.rememberUnlockedSession();
            this.render();
            this.notify();
            return true;
        } finally {
            this.confirming = false;
        }
    }

    /**
     * The way out of an interrupted onboarding: the phrase cannot be shown
     * again, so the unconfirmed wallet is deleted and a new one can be made.
     */
    async resetUnconfirmedWallet() {
        await this.deleteLocalWallet(
            'Delete this wallet and start over? Its recovery phrase was never confirmed and cannot be shown again. If you did save it, cancel and use Recover Wallet instead.'
        );
    }

    async recoverLocal(seedPhrase) {
        if (this.state.seedBackupInterrupted) return this.confirmInterruptedBackup(seedPhrase);
        try {
            const result = await this.wallet.registerLocalWalletFromSeed(seedPhrase);
            // Recovering from the words is proof they were saved.
            clearSeedBackupPending();
            this.state.seedBackupInterrupted = false;
            this.state.publicKey = await this.wallet.getLocalWalletPublicKey();
            await this.refreshNostrIdentity(true);
            this.state.identityType = 'local';
            this.state.address = result.address;
            this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
            this.state.localWalletExists = true;
            this.state.localWalletUnlocked = true;
            this.rememberUnlockedSession();
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

    /**
     * Recover for a wallet whose backup was never confirmed: the phrase is
     * checked against the stored wallet, which proves it was saved, and the
     * wallet then unlocks as usual. Nothing is re-provisioned.
     * @param {string} seedPhrase
     */
    async confirmInterruptedBackup(seedPhrase) {
        try {
            const matches = await this.wallet.seedPhraseMatchesLocalWallet(seedPhrase);
            if (!matches) {
                throw new Error(
                    'This phrase does not belong to the wallet on this device. To use a different wallet, delete this one first.'
                );
            }
        } catch (err) {
            this.toast.error(err.message, 'Recovery failed');
            return false;
        }
        clearSeedBackupPending();
        this.state.seedBackupInterrupted = false;
        this.toast.success('Recovery phrase verified. Unlock with your passkey to continue.', 'Backup confirmed');
        return this.unlockLocal();
    }

    async unlockLocal() {
        // Unlocking is not a way around the backup step: a wallet whose phrase
        // was never confirmed stays locked until it is recovered or reset.
        if (readSeedBackupPending() && !this.state.seedBackupPending) {
            this.state.seedBackupInterrupted = true;
            this.render();
            this.notify();
            this.toast.warning(
                'This wallet\'s recovery phrase was never confirmed. Use Recover Wallet with the words you saved, or delete it and start over.',
                'Backup not confirmed',
                9000
            );
            return false;
        }
        try {
            const result = await this.wallet.unlockLocalWallet();
            this.state.publicKey = await this.wallet.getLocalWalletPublicKey();
            await this.refreshNostrIdentity(true);
            this.state.identityType = 'local';
            this.state.address = result.address;
            this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
            this.rememberUnlockedSession();
            this.state.localWalletUnlocked = true;
            this.render();
            this.notify();
            return true;
        } catch (err) {
            this.toast.error(err.message, 'Unlock failed');
            return false;
        }
    }

    async addAlternatePasskey() {
        try {
            const record = await this.wallet.getLocalWalletRecord();
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
            clearSeedBackupPending();
            this.state.seedBackupInterrupted = false;
            this.state.publicKey = await this.wallet.getLocalWalletPublicKey();
            await this.refreshNostrIdentity(true);
            input.value = '';
            this.state.identityType = 'local';
            this.state.address = result.address;
            this.state.status = AUTH_STATUS.LOCAL_UNLOCKED;
            this.state.localWalletExists = true;
            this.state.localWalletUnlocked = true;
            this.rememberUnlockedSession();
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
            // Locking up on purpose is not an interruption: the place is still
            // remembered, the "unlock again" notice is not.
            markSessionLocked();
            await clearLocalWalletSession();
            // Terminating the worker guarantees nothing survives the disconnect.
            destroyLocalWalletSession();
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

    async deleteLocalWallet(
        message = 'Are you sure you want to delete your local wallet? This action is irreversible — the wallet cannot be recovered without the seed phrase.'
    ) {
        const confirmed = window.confirm(message);
        if (!confirmed) return;
        try {
            const address = this.state.address;
            markSessionLocked();
            await this.wallet.removeLocalWallet();
            clearSeedBackupPending();
            // The wallet is gone, so its Nostr reachability preference is too.
            clearNostrIdentityPreference(address);
            this.state = createAuthState();
            this.render();
            this.notify();
        } catch (err) {
            this.toast.error(err.message, 'Delete failed');
        }
    }

    getActiveIdentity() {
        // A wallet still on its backup step has no identity to act with yet.
        if (this.state.seedBackupPending || this.state.seedBackupInterrupted) {
            return {
                identityType: null,
                address: null,
                chainId: this.state.chainId,
                status: AUTH_STATUS.ANONYMOUS,
                publicKey: null
            };
        }
        return {
            identityType: this.state.identityType,
            address: this.state.address,
            chainId: this.state.chainId,
            status: this.state.status,
            publicKey: this.state.publicKey
        };
    }
}
