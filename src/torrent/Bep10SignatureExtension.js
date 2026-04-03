// @ts-check

export const WEB25_SIG_EXT_NAME = 'web25_sig_v1';

/**
 * Factory that returns a BEP10 wire-extension constructor compatible with
 * `wire.use()` from WebTorrent.
 *
 * The extension announces the EVM signature via the BEP10 extended handshake
 * so that every peer that joins the swarm receives it without any tracker
 * changes.
 *
 * @param {object|null} signedMeta - signature metadata to broadcast, or null
 * @param {function} onReceived - callback called when a remote `sig_announce` arrives
 * @returns {function} Extension constructor
 */
export function createBep10SignatureExtension(signedMeta, onReceived) {
    /**
     * @this {object}
     * @param {object} wire - WebTorrent wire instance
     */
    function Bep10SignatureExtension(wire) {
        this.name = WEB25_SIG_EXT_NAME;
        this._wire = wire;
    }

    Bep10SignatureExtension.prototype.onExtendedHandshake = function () {
        if (!signedMeta || !signedMeta.signature) return;

        try {
            const msg = {
                type: 'sig_announce',
                publisher: signedMeta.publisher,
                signature: signedMeta.signature,
                signatureAlgorithm: signedMeta.signatureAlgorithm || 'EVM_SECP256K1',
                signedAt: signedMeta.signedAt,
                torrentHash: signedMeta.torrentHash,
                chainId: signedMeta.chainId
            };
            const encoded = new TextEncoder().encode(JSON.stringify(msg));
            this._wire.extended(WEB25_SIG_EXT_NAME, encoded);
        } catch (_) {}
    };

    Bep10SignatureExtension.prototype.onMessage = function (buf) {
        try {
            const payload = JSON.parse(new TextDecoder().decode(buf));
            if (payload.type === 'sig_announce' && typeof onReceived === 'function') {
                onReceived(payload);
            }
        } catch (_) {}
    };

    return Bep10SignatureExtension;
}
