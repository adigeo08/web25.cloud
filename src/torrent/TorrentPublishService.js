// @ts-check

export function attachPublishMetadata(hash, signatureResult) {
    return {
        torrentHash: hash,
        signature: signatureResult.signature,
        payload: signatureResult.payload,
        signedMessage: signatureResult.message
    };
}
