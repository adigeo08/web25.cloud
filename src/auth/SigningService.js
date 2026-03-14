// @ts-check

import { signWithExternalWallet } from './ExternalWalletService.js';
import { signWithLocalWallet } from './LocalWalletService.js';
import { serializePayload } from '../torrent/TorrentSignaturePayload.js';

export async function signPublishPayload(payload, identityType, messageOverride) {
    const message = messageOverride || serializePayload(payload);

    const signature =
        identityType === 'external' ? await signWithExternalWallet(message) : await signWithLocalWallet(message);

    return { payload, message, signature };
}

export async function verifyPublishSignature(message, signature, publisherAddress) {
    const viem = await import('https://esm.sh/viem@2.22.21');
    const recovered = await viem.recoverMessageAddress({
        message,
        signature: /** @type {`0x${string}`} */ (signature)
    });

    return recovered.toLowerCase() === publisherAddress.toLowerCase();
}
