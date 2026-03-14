// @ts-check

import { decryptHtmlBlock } from '../crypto/BlockDecryptionService.js';
import { unwrapBlockKey } from '../crypto/WrappedKeyService.js';
import { getGrantsBySite } from './AccessGrantStore.js';
import { getAccessPrivateKey } from './AccessKeyService.js';
import { verifyGrantSignature } from './GrantVerifier.js';
import { createLockedBlockPlaceholder } from '../ui/access/LockedBlockPlaceholder.js';

function findWrappedKey(grants, blockId, epoch, walletAddress) {
    for (const grant of grants) {
        if (grant.recipientAddress?.toLowerCase() !== walletAddress.toLowerCase()) continue;
        if (grant.expiresAt && grant.expiresAt > 0 && Date.now() / 1000 > grant.expiresAt) continue;
        const match = (grant.blocks || []).find((entry) => entry.blockId === blockId && Number(entry.epoch) === epoch);
        if (match?.wrappedKey) return match.wrappedKey;
    }
    return null;
}

export async function unlockEncryptedBlocksInDocument({ doc, siteId, walletAddress }) {
    const encryptedBlocks = Array.from(doc.querySelectorAll('.web25-encrypted-block'));
    if (!encryptedBlocks.length) return { unlocked: 0, locked: 0 };

    const grantsForSite = await getGrantsBySite(siteId);
    const validGrants = [];
    for (const grant of grantsForSite) {
        if (await verifyGrantSignature(grant)) validGrants.push(grant);
    }

    const privateKey = await getAccessPrivateKey(walletAddress);
    let unlocked = 0;
    let locked = 0;

    for (const blockElement of encryptedBlocks) {
        try {
            const blockId = blockElement.getAttribute('data-block-id') || '';
            const epoch = Number(blockElement.getAttribute('data-epoch') || '0');
            const ivBase64 = blockElement.getAttribute('data-iv') || '';
            const ciphertextBase64 = blockElement.getAttribute('data-ciphertext') || '';
            const wrappedKey = findWrappedKey(validGrants, blockId, epoch, walletAddress);

            if (!wrappedKey || !privateKey) throw new Error('No matching grant');

            const blockKey = await unwrapBlockKey(wrappedKey, privateKey);
            const html = await decryptHtmlBlock({ ivBase64, ciphertextBase64, blockKey });
            blockElement.innerHTML = html;
            blockElement.classList.remove('web25-encrypted-block');
            blockElement.classList.add('web25-decrypted-block');
            unlocked += 1;
        } catch (_error) {
            blockElement.replaceWith(createLockedBlockPlaceholder());
            locked += 1;
        }
    }

    return { unlocked, locked };
}
