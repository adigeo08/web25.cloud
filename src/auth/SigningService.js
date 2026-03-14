// @ts-check

import { signWithExternalWallet } from './ExternalWalletService.js';
import { signWithLocalWallet } from './LocalWalletService.js';
import { loadViemAccounts } from '../web3/viemClients.js';
import { serializePayload } from '../torrent/TorrentSignaturePayload.js';

export async function signPublishPayload(payload, identityType, messageOverride) {
    const message = messageOverride || serializePayload(payload);

    const signature =
        identityType === 'external' ? await signWithExternalWallet(message) : await signWithLocalWallet(message);

    return { payload, message, signature };
}

export async function verifyPublishSignature(message, signature, publisherAddress) {
    const viemAccounts = await loadViemAccounts();
    const recovered = await viemAccounts.recoverMessageAddress({
        message,
        signature: /** @type {`0x${string}`} */ (signature)
    });

    return recovered.toLowerCase() === publisherAddress.toLowerCase();
}
