// @ts-check
/**
 * Main-thread Nostr primitives.
 *
 * Everything exported here is either public-key-only work (event
 * verification, `npub` encoding) or work performed with a throwaway
 * gift-wrap key. Operations that need the wallet's private key live in the
 * dedicated wallet worker and are reached through `WalletWorkerClient.js`.
 */

import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { extract as hkdfExtract, expand as hkdfExpand } from '@noble/hashes/hkdf';
import { chacha20 } from '@noble/ciphers/chacha';
import { createNostrCore } from './nostrCore.js';
import { createNip59 } from './nip59.js';

export const nostrCore = createNostrCore({
    secp256k1,
    schnorr,
    sha256: (data) => sha256(data),
    hmac: (hash, key, message) => hmac(hash, key, message),
    sha256Hash: sha256,
    hkdfExtract,
    hkdfExpand,
    chacha20
});

export const nip59 = createNip59(nostrCore);

export const verifyNostrEvent = (event) => nostrCore.verifyEvent(event);
export const nostrPublicKeyFromEciesPublicKey = (publicKey) => nostrCore.nostrPublicKeyFromEciesPublicKey(publicKey);
export { npubEncode, npubDecode, normalizeNostrPublicKey, shortNpub } from './nip19.js';
