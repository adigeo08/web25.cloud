// @ts-check

import { signWithExternalWallet } from './ExternalWalletService.js';
import { signWithLocalWallet } from './LocalWalletService.js';
import { buildTorrentSignaturePayload, serializePayload } from '../torrent/TorrentSignaturePayload.js';

export async function signPublishPayload(input, identityType) {
    const payload = buildTorrentSignaturePayload(input);
    const message = serializePayload(payload);

    const signature =
        identityType === 'external' ? await signWithExternalWallet(message) : await signWithLocalWallet(message);

    return { payload, message, signature };
}
