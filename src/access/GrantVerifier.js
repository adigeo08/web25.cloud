// @ts-check

import { loadViemAccounts } from '../web3/viemClients.js';

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item));
    }
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .sort()
            .reduce((acc, key) => {
                acc[key] = canonicalize(value[key]);
                return acc;
            }, {});
    }
    return value;
}

export function buildGrantSigningMessage(grant) {
    const unsignedGrant = { ...grant };
    delete unsignedGrant.signature;
    return JSON.stringify(canonicalize(unsignedGrant));
}

export async function verifyGrantSignature(grant) {
    if (!grant?.signature || !grant?.publisherAddress) return false;
    const viemAccounts = await loadViemAccounts();
    const message = buildGrantSigningMessage(grant);
    const recovered = await viemAccounts.recoverMessageAddress({ message, signature: grant.signature });
    return recovered.toLowerCase() === grant.publisherAddress.toLowerCase();
}
