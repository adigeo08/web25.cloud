# Direct Message P2P bootstrap via `.torrentchain` + magnet links

## 1) Existing mechanisms analysis

### A. Static deploy path (`WebTorrent` + `.torrentchain`)

- WebTorrent client is initialized once in lifecycle with browser-safe trackers (`wss://` and `https://`) and explicit RTC config. `initializeWebTorrent()` wires tracker announce list + STUN servers. `this.trackers` is reused by upload/load flows. 
- Deploy signing flow builds `.torrentchain` as a separate root file and seeds it together with deploy payload.
  - `createTorrentChainArtifact()` composes `payload` (`schema`, `publisher`, `chainId`, `createdAt`, `fileCount`, `totalBytes`, `merkleRoot`, optional `bundle`) and signs with wallet identity.
  - Manifest stores payload + signature + file SHA256 table.
- Seeding and magnet generation happen through WebTorrent seed/add APIs:
  - upload seeds in-memory files and exposes `infoHash` (used to compose magnet URI);
  - load path composes `magnet:?xt=urn:btih:<hash>&tr=...` and adds via `client.add()`.
- Verification path before rendering:
  - `.torrentchain` is read first if present;
  - `verifyTorrentChainManifest()` validates signature against `payload.publisher`.
  - optional strict mode blocks load if missing/invalid manifest;
  - entry file hash and (gzip mode) bundle hash checks gate rendering.

**Reusable parts immediately:**
1. `createTorrentChainArtifact()` and `verifyTorrentChainManifest()`.
2. file hash + Merkle draft generation (`buildTorrentChainDraft()`).
3. existing EVM signing + signature verification in `SigningService`.
4. existing tracker/magnet construction patterns from loader/uploader.

### B. Direct Message path (`WebRTC` + STUN + ECIES)

- `ChannelsService` currently does manual signaling with JSON “signal code” that embeds:
  - base64 SDP description (`offer` or `answer`);
  - peer `evmAddress`;
  - peer secp256k1 public key.
- STUN remains `stun:stun.l.google.com:19302` in DM service default RTC config.
- Identity checks already exist in signaling parse stage:
  - if `publicKey` + `evmAddress` exist, address is derived from pubkey and compared.
- E2E message crypto stays on data-channel payload:
  - sender signs plaintext;
  - wraps `{ plaintext, signature }`;
  - encrypts envelope with ECIES to peer pubkey;
  - receiver decrypts and verifies signature.
- Manual UX points today:
  - host copies offer text;
  - guest pastes offer, copies answer;
  - host pastes answer.

**Key observation:** ICE trickle is not exchanged incrementally; flow waits for ICE gathering and bundles local description in one signal object, so 2 artifacts (offer bootstrap + answer bootstrap) are enough for current handshake model.

## 2) Bridge architecture proposal (without replacing WebRTC/ECIES)

Create a **bootstrap transport layer** for DM using WebTorrent + `.torrentchain` and keep `ChannelsService` crypto/data-plane unchanged.

### New concept

Each peer publishes a small JSON (`dm-bootstrap.json`) as a torrent that also includes `.torrentchain`.

- Transport: magnet link.
- AuthN/AuthZ: `.torrentchain` signature + payload checks.
- Payload content: signaling data currently copied manually.
- Data channel, STUN, ECIES chat encryption: unchanged.

## 3) Recommended DM bootstrap JSON

```json
{
  "type": "direct-message-bootstrap",
  "version": 1,
  "role": "offer|answer",
  "from": {
    "evmAddress": "0x...",
    "identityPublicKey": "04...",
    "identitySignature": "0x..."
  },
  "to": {
    "evmAddress": "0x..."
  },
  "webrtc": {
    "sdp": { "type": "offer", "sdp": "..." },
    "iceComplete": true,
    "stunServers": ["stun:stun.l.google.com:19302"]
  },
  "session": {
    "sessionId": "hex-random",
    "createdAt": 1777550000000,
    "expiresAt": 1777551800000,
    "nonce": "hex-random"
  }
}
```

Notes:
- `identitySignature` is optional if `.torrentchain` signature is considered sufficient for publisher proof; keep optional for forward compatibility.
- `to.evmAddress` is mandatory to enforce intended recipient check.
- keep short TTL (10–30 min).

## 4) Verification rules for imported magnet

When A imports B magnet (and vice versa), run:
1. download torrent;
2. extract `.torrentchain` + `dm-bootstrap.json`;
3. `verifyTorrentChainManifest(manifest)`;
4. ensure `manifest.payload.publisher == bootstrap.from.evmAddress`;
5. ensure local user address equals `bootstrap.to.evmAddress`;
6. recompute SHA256 for `dm-bootstrap.json` and match manifest file entry;
7. enforce TTL (`now <= expiresAt`) and max age;
8. replay protection: cache tuple `(from, to, sessionId, nonce)` and reject duplicates.

## 5) Answers to requested questions

1. **Reusable directly:** `.torrentchain` build/verify, signer verification, WebTorrent seeding/loading patterns, tracker config.
2. **Extract to common module:** DM-specific torrent helpers (seed/load/find file) + generic `verifyTorrentPayloadAgainstManifest(fileName, bytes, manifest)` utility.
3. **Required JSON fields:** role, from identity (evm+pubkey), recipient evm, SDP, session id, nonce, timestamps, expiry.
4. **Are 2 magnet links enough?** Yes for current non-trickle flow (offer artifact + answer artifact).
5. **If not enough:** only if later enabling trickle ICE; then would need update channel or re-publish deltas.
6. **Can we eliminate manual SDP/ICE/key copy?** Yes; users exchange only magnets.
7. **What stays on WebRTC/STUN:** peer connection setup, ICE gathering, data channel transport.
8. **What stays ECIES-encrypted:** actual chat/file message payloads on data channel.
9. **Risks with public torrent JSON:** metadata leakage (addresses, timing, room/session correlation), replay, scraping.
10. **Encrypt vs public:** SDP + addresses can remain public if recipient-bound + short TTL; never include private keys or wallet secrets; optional extra encryption for SDP can be added later.
11. **How verify magnet belongs to expected EVM:** `.torrentchain` signature recovers publisher; compare to expected EVM and bootstrap `from`.
12. **How verify intended recipient:** enforce `bootstrap.to.evmAddress === localAddress`.
13. **Replay prevention:** TTL + nonce/session cache + reject stale `createdAt`.
14. **Recommended expiration:** default 15 minutes; hard max 30 minutes.
15. **Concrete DM page changes:** replace textarea offer/answer exchange with magnet create/import controls; keep channel connect/send UI.

## 6) Concrete implementation plan

1. Add `src/channels/DirectMessageTorrentBootstrap.js` with:
   - `createDirectMessageBootstrapTorrent(...)`
   - `loadDirectMessageBootstrapFromMagnet(...)`
   - `verifyDirectMessageTorrentchain(...)`
2. Extend `ChannelsService` with low-level methods:
   - `createOfferSignalPayload(identity)` returns decoded signal object (not encoded string)
   - `createAnswerSignalPayloadFromOfferPayload(...)`
   - `applyRemoteAnswerPayload(...)`
   (keep existing methods for backward compatibility).
3. Update `Lifecycle.setupChannels()` and `ChannelsPanel`:
   - add generate magnet buttons for offer/answer;
   - add import magnet input for remote offer/answer;
   - auto-run verify+handshake after import.
4. Reuse existing WebTorrent client (`this.client`) and tracker list (`this.trackers`) for DM bootstrap torrents.
5. Add in-memory replay cache + expiry checks.
6. Keep old manual mode under a feature flag fallback until stable.

## 7) Pseudocode snippets

```js
async function createDirectMessageBootstrapTorrent({ client, trackers, identity, recipientAddress, role, signalPayload }) {
  const bootstrap = buildBootstrapJson({ identity, recipientAddress, role, signalPayload });
  const bootstrapBytes = new TextEncoder().encode(JSON.stringify(bootstrap, null, 2));
  const bootstrapFile = makeVirtualFile('dm-bootstrap.json', bootstrapBytes, 'application/json');

  const chainArtifact = await createTorrentChainArtifact({
    inMemoryFiles: [bootstrapFile],
    publisher: identity.address,
    chainId: identity.chainId || 1,
    identityType: identity.identityType,
    createdAt: bootstrap.session.createdAt,
    bundle: null,
    filesSemantics: 'torrent-entries'
  });

  const chainFile = makeVirtualFile('.torrentchain', chainArtifact.content, 'application/json');
  const torrent = await seedFiles(client, [chainFile, bootstrapFile], trackers, `dm-${role}-${bootstrap.session.sessionId}`);
  return { magnetURI: torrent.magnetURI, infoHash: torrent.infoHash, bootstrap };
}
```

```js
async function loadDirectMessageBootstrapFromMagnet({ client, magnetURI, expectedFrom, localAddress }) {
  const torrent = await addMagnet(client, magnetURI);
  const { manifest, bootstrap, bootstrapBytes } = await extractManifestAndBootstrap(torrent);
  await verifyDirectMessageTorrentchain({ manifest, bootstrap, bootstrapBytes, expectedFrom, localAddress });
  return bootstrap;
}
```

```js
async function verifyDirectMessageTorrentchain({ manifest, bootstrap, bootstrapBytes, expectedFrom, localAddress }) {
  const sig = await verifyTorrentChainManifest(manifest);
  if (!sig.verified) throw new Error('Invalid .torrentchain signature');
  if (sig.publisher.toLowerCase() !== bootstrap.from.evmAddress.toLowerCase()) throw new Error('Publisher mismatch');
  if (expectedFrom && sig.publisher.toLowerCase() !== expectedFrom.toLowerCase()) throw new Error('Unexpected sender');
  if (bootstrap.to.evmAddress.toLowerCase() !== localAddress.toLowerCase()) throw new Error('Not addressed to current user');
  enforceExpiryAndReplay(bootstrap.session);
  await verifyManifestEntryHash(manifest, 'dm-bootstrap.json', bootstrapBytes);
  return true;
}
```
