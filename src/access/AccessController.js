// @ts-check

import { importGrant } from './AccessGrantService.js';
import { ensureAccessKeyPair, getAccessPublicKey } from './AccessKeyService.js';
import { listAllGrants } from './AccessGrantStore.js';
import { bindAccessPanel, renderAccessPanel } from '../ui/access/AccessPanel.js';
import { bindGrantImport } from '../ui/access/GrantImportModal.js';

export default class AccessController {
    constructor({ toast, getWalletAddress }) {
        this.toast = toast;
        this.getWalletAddress = getWalletAddress;
    }

    async init() {
        bindAccessPanel({
            onGenerateKey: async () => this.generateAccessKey(),
            onImportGrant: () => document.getElementById('grant-import-input')?.click(),
            onExportPublicKey: async () => this.exportPublicKey()
        });

        bindGrantImport(async (grant) => {
            await importGrant(grant);
            await this.render();
            this.toast.success('Token imported and verified.', 'Access grant imported');
        });

        await this.render();
    }

    async render() {
        const walletAddress = this.getWalletAddress();
        if (!walletAddress) {
            renderAccessPanel({ publicKey: null, grants: [] });
            return;
        }

        const publicKey = await getAccessPublicKey(walletAddress);
        const grants = (await listAllGrants()).filter(
            (grant) => grant.recipientAddress?.toLowerCase() === walletAddress.toLowerCase()
        );
        renderAccessPanel({ publicKey, grants });
    }

    async exportPublicKey() {
        const walletAddress = this.getWalletAddress();
        if (!walletAddress) throw new Error('Unlock local wallet first.');
        const publicKey = await getAccessPublicKey(walletAddress);
        if (!publicKey) throw new Error('Generate access key first.');
        await navigator.clipboard.writeText(publicKey);
        this.toast.success('Public key copied to clipboard.', 'Access key exported');
    }

    async generateAccessKey() {
        const walletAddress = this.getWalletAddress();
        if (!walletAddress) throw new Error('Unlock local wallet first.');
        await ensureAccessKeyPair(walletAddress);
        await this.render();
        this.toast.success('Access key generated and bound to wallet.', 'Access key ready');
    }
}
