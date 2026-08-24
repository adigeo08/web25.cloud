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
  - `.torrentchain` is required and read first;
  - `verifyTorrentChainManifest()` validates signature against `payload.publisher`;
  - missing, malformed, or invalid manifest blocks load/render;
  - entry file hash and (gzip mode) bundle hash checks gate rendering.

**Reusable parts immediately:**
1. `createTorrentChainArtifact()` and `verifyTorrentChainManifest()`.
2. file hash + Merkle draft generation (`buildTorrentChainDraft()`).
3. existing EVM signing + signature verification in `SigningService`.
4. existing tracker/magnet construction patterns from loader/uploader.

### B. Direct Message path (`WebRTC` + STUN + ECIES)

- `ChannelsService` currently does manual signaling with JSON "signal code" that embeds:
  - base64 SDP description (`offer` or `answer`);
  - peer `evmAddress`;
  - peer secp256k1 public key.
- STUN remains `stun:stun.l.google.com:19302` in DM service default RTC config.
- Identity checks in signaling parse stage:
  - `publicKey` + `evmAddress` are mandatory on both offer and answer;
  - address is derived from pubkey and compared before continuing.
- E2E message crypto stays on data-channel payload:
  - sender signs plaintext;
  - wraps `{ plaintext, signature }`;
  - encrypts envelope with ECIES to peer pubkey;
  - receiver decrypts and verifies signature.
- No plaintext fallback is allowed in DM send/receive paths.

## 2) Bridge architecture (v2 encrypted protocol)

Each peer publishes a small JSON (`dm-bootstrap.json`) as a torrent that also includes `.torrentchain`.

- **Transport:** magnet link.
- **AuthN/AuthZ:** `.torrentchain` signature + payload checks.
- **Confidentiality:** ECIES-encrypted inner payload (only the intended recipient can decrypt).
- **Data channel, STUN, ECIES chat encryption:** unchanged.

### Key design principle

The torrent file contains a **minimal plaintext envelope** signed by `.torrentchain`, plus an **ECIES-encrypted inner payload** that can only be decrypted by the intended recipient's private key. The host must know (and validate) the recipient's secp256k1 ECIES public key before generating an offer.

## 3) v2 Bootstrap envelope schema

### Outer envelope (plaintext, signed by `.torrentchain`)

```json
{
  "type": "direct-message-bootstrap-v2",
  "version": 2,
  "role": "offer|answer",
  "from": { "evmAddress": "0xSENDER" },
  "to": { "evmAddress": "0xRECIPIENT" },
  "createdAt": 1777550000000,
  "expiresAt": 1777551800000,
  "encrypted": {
    "algorithm": "ECIES-secp256k1-HKDF-SHA256-AES-256-GCM",
    "ciphertext": "<hex ECIES payload>"
  }
}
```

### Inner payload (ECIES-encrypted; only recipient can read)

```json
{
  "from": {
    "evmAddress": "0xSENDER",
    "eciesPublicKey": "04..."
  },
  "webrtc": {
    "description": { "type": "offer", "sdp": "..." },
    "iceComplete": true,
    "stunServers": ["stun:stun.l.google.com:19302"]
  },
  "session": {
    "sessionId": "hex-random-24-chars",
    "replyToSessionId": null,
    "createdAt": 1777550000000,
    "expiresAt": 1777551800000,
    "nonce": "hex-random-24-chars"
  }
}
```

**What is visible in plaintext (pre-decryption):**
- Sender and recipient EVM addresses, creation/expiry timestamps.
- Existence of a DM invite on the network (not its content).

**What is confidential (inside ciphertext):**
- WebRTC SDP offer/answer (ICE candidates, codecs, etc.).
- Sender ECIES public key.
- `sessionId`, `replyToSessionId`, and `nonce` — no session correlation from torrent metadata.
- Torrent name is `dm-offer` or `dm-answer` (no `sessionId` embedded).

**Note:** `containerKey` has been removed. Session binding uses `sessionId` / `replyToSessionId` only.

## 4) Verification rules for imported magnet

When peer A imports a magnet from peer B:
1. Download torrent.
2. Extract `.torrentchain` + `dm-bootstrap.json`.
3. `verifyTorrentChainManifest(manifest)` → get verified `publisher`.
4. Verify `publisher === envelope.from.evmAddress`.
5. Verify `envelope.to.evmAddress === localAddress` (recipient binding).
6. Recompute SHA256 for `dm-bootstrap.json` and match manifest file entry.
7. Verify `createdAt` not too far in the future (max 2 min skew) and `expiresAt > now`.
8. Decrypt `envelope.encrypted.ciphertext` via the dedicated wallet worker's `ECIES_DECRYPT` operation (`decryptFn`); the private key never reaches this module or the main thread.
9. Verify `innerPayload.from.evmAddress === envelope.from.evmAddress`.
10. Verify `evmAddressFromPublicKey(innerPayload.from.eciesPublicKey) === innerPayload.from.evmAddress`.
11. Verify inner timestamps.
12. For answers: verify `innerPayload.session.replyToSessionId === expectedSessionId`.
13. Replay protection: cache `(from, to, sessionId, nonce)` and reject duplicates.

## 5) Offer/answer flow

### Offer: Host → Guest

1. Host knows the guest's ECIES public key (`04…` hex).
2. Host derives `recipientAddress = evmAddressFromPublicKey(recipientPublicKey)`.
3. Host creates inner payload: SDP offer, own `eciesPublicKey`, `sessionId`, timestamps, nonce.
4. Host ECIES-encrypts inner payload to guest's public key.
5. Host creates plaintext envelope with `from/to` addresses + ciphertext.
6. Host signs envelope with `.torrentchain` and seeds the torrent.
7. Host shares the magnet link with the guest.

### Answer: Guest → Host

1. Guest receives the magnet link, downloads torrent.
2. Guest validates signature + recipient binding.
3. Guest decrypts offer with their local private key.
4. Guest validates inner payload coherence (address ↔ public key, timestamps, etc.).
5. Guest creates answer inner payload: SDP answer, own public key, `replyToSessionId = offer.session.sessionId`, timestamps, nonce.
6. Guest ECIES-encrypts answer to **host's** `eciesPublicKey` (recovered from decrypted offer).
7. Guest signs envelope with `.torrentchain` and seeds the answer torrent.
8. Guest shares the answer magnet link with the host.
9. Host validates, decrypts, verifies `replyToSessionId` matches active offer, applies WebRTC answer.

## 6) Security properties

| Property | Mechanism |
|---|---|
| **Authenticity** | `.torrentchain` signature by sender's EVM key |
| **Integrity** | SHA256 file hash in `.torrentchain` manifest |
| **Confidentiality** | ECIES encryption of inner payload |
| **Recipient binding** | `to.evmAddress` check + only correct private key decrypts |
| **Sender binding** | `publisher === from.evmAddress` + key/address coherence in inner payload |
| **Replay protection** | Nonce + session ID + in-memory cache per session |
| **Expiry** | Short TTL (15 min default); `expiresAt` enforced on both envelope and inner payload |
| **Session correlation** | `sessionId` / `replyToSessionId` inside ciphertext; not in torrent name or plaintext |

**No private keys** ever enter the torrent, envelope, UI, logs, or tests. Since the wallet
worker landed, they do not enter the bootstrap module either: callers pass a
`decryptFn` capability handle backed by the worker.

## 7) Migration from v1

Legacy v1 bootstrap artifacts (`type: "direct-message-bootstrap"`, `version: 1`) are **rejected** with a clear error:

> "This is a legacy v1 Direct Message bootstrap artifact. The v1 unencrypted protocol is no longer supported. Please ask your peer to generate a new encrypted invite using the current version."

There is no silent fallback. All parties must use v2 clients.

## 8) Implementation modules

- **`src/channels/DirectMessageTorrentBootstrap.js`**
  - `createEncryptedDMBootstrapArtifact(...)` — build envelope + encrypt inner payload
  - `decryptAndVerifyDMBootstrapArtifact(...)` — decrypt + validate (injectable verifier for tests)
  - `createDirectMessageBootstrapTorrent(...)` — full WebTorrent seed flow
  - `loadDirectMessageBootstrapFromMagnet(...)` — full WebTorrent load + verify flow
  - `verifyDirectMessageTorrentchain(...)` — validate manifest + decrypt + verify
- **`src/channels/ecies.js`** — `eciesEncrypt`, `eciesDecrypt`, `getPublicKeyFromPrivateKey`, `evmAddressFromPublicKey`
- **`src/core/bootstrap/Lifecycle.js`** — orchestration; passes `recipientPublicKey` and `localPrivateKey`
- **`src/ui/channels/ChannelsPanel.js`** — reads `#dm-recipient-pubkey-input` and passes to callback

