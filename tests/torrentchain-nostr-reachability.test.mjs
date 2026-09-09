import test from 'node:test';
import assert from 'node:assert/strict';

import * as ecies from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';
import { canonicalizeOwner, createTorrentChainArtifact } from '../src/torrent/TorrentChainProtocol.js';
import { newUuid } from '../src/torrent/ProtectedAssetProtocol.js';

const OWNER_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const OWNER_PUB = ecies.getPublicKeyFromPrivateKey(OWNER_KEY);
const OWNER_ADDRESS = ecies.evmAddressFromPublicKey(OWNER_PUB);
const OWNER_NOSTR = nostrCore.getNostrPublicKey(OWNER_KEY);
const OWNER_NPUB = npubEncode(OWNER_NOSTR);

function virtualFile(path, text) {
    const bytes = new TextEncoder().encode(text);
    return {
        name: path.split('/').pop(),
        webkitRelativePath: path,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
}

test('TorrentChain derives owner Nostr identity when reachability fields are absent', () => {
    const owner = canonicalizeOwner({
        evmAddress: OWNER_ADDRESS,
        eciesPublicKey: OWNER_PUB,
        nostrPublicKey: '',
        npub: ''
    });

    assert.equal(owner.nostrPublicKey, OWNER_NOSTR);
    assert.equal(owner.npub, OWNER_NPUB);
});

test('explicit owner Nostr fields must still match the ECIES key', () => {
    const foreignKey = '0x2222222222222222222222222222222222222222222222222222222222222222';
    const foreignNostr = nostrCore.getNostrPublicKey(foreignKey);

    assert.throws(
        () => canonicalizeOwner({
            evmAddress: OWNER_ADDRESS,
            eciesPublicKey: OWNER_PUB,
            nostrPublicKey: foreignNostr,
            npub: npubEncode(foreignNostr)
        }),
        /not the x coordinate/
    );
});

test('a wallet can create a TorrentChain manifest with Nostr reachability disabled', async () => {
    const artifact = await createTorrentChainArtifact({
        inMemoryFiles: [virtualFile('index.html', '<html><body>hello</body></html>')],
        publisher: OWNER_ADDRESS,
        chainId: 1,
        identityType: 'local-wallet',
        createdAt: '2026-09-10T00:00:00.000Z',
        siteId: newUuid(),
        owner: {
            evmAddress: OWNER_ADDRESS,
            eciesPublicKey: OWNER_PUB,
            nostrPublicKey: '',
            npub: ''
        },
        protectedAssets: [],
        _signPayloadFn: async (payload, _identityType, message) => ({
            payload,
            message,
            signature: 'test-signature'
        })
    });

    assert.equal(artifact.payload.owner.nostrPublicKey, OWNER_NOSTR);
    assert.equal(artifact.payload.owner.npub, OWNER_NPUB);
});
