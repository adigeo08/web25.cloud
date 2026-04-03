// @ts-check

export function evaluateRenderGate({ signatureVerified, strictMode, hasTorrentChain, bundleHashExpected, bundleHashActual }) {
    if (strictMode && !hasTorrentChain) {
        return { allowed: false, reason: 'missing-torrentchain-strict' };
    }
    if (hasTorrentChain && !signatureVerified) {
        return { allowed: false, reason: 'signature-invalid' };
    }
    if (bundleHashExpected && bundleHashExpected !== bundleHashActual) {
        return { allowed: false, reason: 'bundle-hash-mismatch' };
    }
    return { allowed: true, reason: 'ok' };
}
