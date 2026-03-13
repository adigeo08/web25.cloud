// @ts-check

const ORDERED_KEYS = [
    'torrentHash',
    'siteName',
    'createdAt',
    'version',
    'publisherAddress',
    'contentRoot',
    'chainId'
];

export function buildTorrentSignaturePayload(data) {
    const payload = {
        torrentHash: data.torrentHash,
        siteName: data.siteName || 'unnamed-site',
        createdAt: data.createdAt,
        version: '1',
        publisherAddress: data.publisherAddress,
        contentRoot: data.contentRoot || data.torrentHash,
        chainId: data.chainId
    };

    return ORDERED_KEYS.reduce((acc, key) => {
        acc[key] = payload[key];
        return acc;
    }, {});
}

export function serializePayload(payload) {
    return JSON.stringify(payload);
}
