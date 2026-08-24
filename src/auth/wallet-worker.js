// @ts-check
/**
 * Dedicated Worker that owns the unlocked EVM private key.
 *
 * The key is handed over exactly once, right after the WebAuthn-protected
 * vault is decrypted, and never leaves this scope again. The worker answers
 * only the fixed operation set in `walletWorkerProtocol.js`; there is no
 * command that returns the key and no generic "execute" escape hatch.
 *
 * Terminating or restarting the worker loses the key, which is the intended
 * behaviour: a restarted worker means a locked wallet.
 *
 * This file is only the transport adapter — the session logic lives in
 * `walletWorkerCore.js` so it can be tested without worker globals.
 */

import { workerEcies } from './workerCrypto.js';
import { createWalletWorkerCore } from './walletWorkerCore.js';

const core = createWalletWorkerCore({
    ecies: workerEcies,
    onLock: (reason) => self.postMessage({ type: 'EVENT', event: 'LOCKED', reason })
});

self.addEventListener('message', async (event) => {
    self.postMessage(await core.handle(event.data));
});

self.postMessage({ type: 'EVENT', event: 'READY' });
