// @ts-check
/**
 * secp256k1 primitives for the dedicated wallet worker.
 *
 * Import maps declared in `index.html` do not apply to worker module graphs,
 * so the worker resolves the very same `@noble` builds by absolute URL. The
 * algorithms themselves come from the shared `eciesCore` factory, so the main
 * thread and the worker can never drift apart.
 */

import { secp256k1 } from 'https://esm.sh/@noble/curves@1.4.2/secp256k1';
import { keccak_256 } from 'https://esm.sh/@noble/hashes@1.4.0/sha3.js';
import { createEcies } from '../channels/eciesCore.js';

export const workerEcies = createEcies({ secp256k1, keccak_256 });

export { workerNostr } from './workerNostr.js';
