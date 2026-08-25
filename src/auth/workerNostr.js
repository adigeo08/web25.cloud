// @ts-check
/**
 * Nostr primitives for the dedicated wallet worker.
 *
 * Import maps declared in `index.html` do not apply to worker module graphs,
 * so the worker resolves the very same `@noble` builds by absolute URL. The
 * algorithms themselves come from the shared `nostrCore` factory, so the main
 * thread and the worker can never drift apart.
 */

import { secp256k1, schnorr } from 'https://esm.sh/@noble/curves@1.4.2/secp256k1';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.4.0/sha256.js';
import { hmac } from 'https://esm.sh/@noble/hashes@1.4.0/hmac.js';
import { extract as hkdfExtract, expand as hkdfExpand } from 'https://esm.sh/@noble/hashes@1.4.0/hkdf.js';
import { chacha20 } from 'https://esm.sh/@noble/ciphers@1.3.0/chacha.js';
import { createNostrCore } from '../nostr/nostrCore.js';

export const workerNostr = createNostrCore({
    secp256k1,
    schnorr,
    sha256: (data) => sha256(data),
    hmac: (hash, key, message) => hmac(hash, key, message),
    sha256Hash: sha256,
    hkdfExtract,
    hkdfExpand,
    chacha20
});
