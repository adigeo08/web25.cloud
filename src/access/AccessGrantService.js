// @ts-check

import { signWithLocalWallet } from '../auth/LocalWalletService.js';
import { createBlockKey } from '../crypto/BlockEncryptionService.js';
import { importRecipientEncryptionPublicKey, wrapBlockKeyForRecipient } from '../crypto/WrappedKeyService.js';
import { saveGrant } from './AccessGrantStore.js';
import { buildGrantSigningMessage, verifyGrantSignature } from './GrantVerifier.js';

function randomGrantId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function importGrant(grant) {
    const valid = await verifyGrantSignature(grant);
    if (!valid) throw new Error('Invalid grant signature');
    await saveGrant(grant);
    return grant;
}

export async function createGrant({ siteId, publisherAddress, recipientAddress, recipientEncryptionPublicKey, blocks, expiresAt = 0 }) {
    const recipientPublicKey = await importRecipientEncryptionPublicKey(recipientEncryptionPublicKey);
    const wrappedBlocks = [];

    for (const block of blocks) {
        const blockKey = block.blockKey || (await createBlockKey());
        const wrappedKey = await wrapBlockKeyForRecipient(blockKey, recipientPublicKey);
        wrappedBlocks.push({ blockId: block.blockId, epoch: block.epoch, wrappedKey });
    }

    const grant = {
        version: 1,
        grantId: randomGrantId(),
        siteId,
        publisherAddress,
        recipientAddress,
        recipientEncryptionPublicKey,
        issuedAt: Math.floor(Date.now() / 1000),
        expiresAt,
        blocks: wrappedBlocks
    };

    grant.signature = await signWithLocalWallet(buildGrantSigningMessage(grant));
    return grant;
}
