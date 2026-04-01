# ☁️ Web25.Cloud

**Decentralized web platform for peer-to-peer static site hosting + local in-browser signing + signed torrent publishing + P2P channels, fully in-browser.**

Web25.Cloud extends PeerWeb with a modular architecture and an identity-aware publishing flow.

---

## What is implemented now

### 1) Clear UI split (Identity / Publish / Channels / Browse)

The application UI is now separated into:

- **Identity / Auth**
  - Register Local Wallet
  - Unlock Local Wallet
  - Recover Local Wallet from seed phrase
  - Disconnect
  - Delete Local Wallet
- **Publish**
  - Select/drop files
  - Build in-memory bundle
  - Create torrent from memory bundle
  - Preview signing payload
  - Sign payload
  - Publish output (signed metadata)
- **Browse / Load**
  - Existing torrent-hash loading flow remains available
- **Channels (P2P chat over torrent swarm extension)**
  - Join/leave named channels
  - Peer count updates in real time
  - Send/receive signed identity-tagged messages over WebTorrent wires
  - Per-session chat stream in dedicated Channels tab

### 2) Local browser wallet (viem + WebCrypto + IndexedDB)

Local identity supports:

- Register local wallet
- Generate and show seed phrase once
- Auto-copy generated seed phrase to clipboard (best effort)
- Security warning on generation: **do not use this wallet for deposits or storing funds**
- Persist wallet metadata in IndexedDB
- Unlock and sign publish payloads
- Delete local wallet

Stored wallet metadata includes:

- `walletId`
- `address`
- `encryptedPrivateKey`
- `createdAt`
- `lastUsedAt`

#### Security model

Private key is **not stored in plaintext**:

1. A non-extractable WebCrypto `CryptoKey` (AES-GCM) is created/managed.
2. Private key is encrypted before persistence.
3. Encrypted key + IV are stored in IndexedDB.
4. Private key is decrypted only temporarily in memory for signing.

> Note: seed phrase is displayed at registration time and not persisted in clear text. Save it immediately.

---

### 3) Deterministic publish signing payload + signed torrent metadata

Torrent publish signature payload is deterministic and serialized predictably.

Fields used:

- `torrentHash`
- `siteName`
- `createdAt`
- `version`
- `publisherAddress`
- `contentRoot`
- `chainId`

Signing flow:

1. User drops/selects site files
2. App builds an in-memory normalized bundle (browser memory only)
3. App creates torrent from that memory bundle and keeps publish candidate (hash + site metadata)
4. User signs payload with active local identity
5. Signed publish output is generated in-browser
6. Signed metadata is attached directly inside the `.torrent` artifact (`publisher`, `signature`, `signature_algorithm`, `signed_at`, `chain_id`)

At load time (hash browse flow), the client verifies signature metadata from the torrent root and mirrors it into `manifest.web25.json` for runtime introspection and consistency checks.

Supported signed torrent flow now includes:

- deterministic payload build (`TorrentSignaturePayload`)
- signer digest generation + local wallet message signing
- signature embedding into bencoded torrent metadata
- signature verification when loading artifacts
- publisher badge/status rendering in runtime UI

---

### 4) Signed deploy session persistence (refresh-safe)

- Signed deploy artifacts are persisted in `localStorage` under `web25.deploy.session.v1`
- On refresh, Web25.Cloud restores signing/deploy UI state and re-adds the signed torrent to WebTorrent
- This enables continuing seeding/redeploy flows without repeating sign steps in normal scenarios
- WebTorrent runtime script is loaded from:
  - `https://cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js`

---

### 5) Channels over WebTorrent peer wires

Channels are implemented as deterministic swarms derived from channel names:

- channel names are normalized and hashed into stable info hashes
- each channel is joined as a lightweight magnet swarm
- chat payloads are exchanged through a custom extension (`web25_channels_v1`)
- UI renders message timeline, local-vs-remote message markers, and live peer count
- identity address (when available) is included in message metadata

---

## Architecture (modular, no new monolith)

Implemented modules:

```text
src/
├── auth/
│   ├── AuthController.js
│   ├── AuthState.js
│   ├── LocalWalletService.js
│   ├── SeedPhraseService.js
│   ├── SecureKeyStore.js
│   └── SigningService.js
│
├── channels/
│   └── ChannelsService.js
│
├── ui/
│   ├── auth/
│   │   ├── AuthPanel.js
│   │   ├── RegisterWalletModal.js
│   │   ├── SeedPhraseScreen.js
│   │   ├── UnlockWalletModal.js
│   │   └── IdentityBadge.js
│   │
│   ├── publish/
│   │   ├── PublishPanel.js
│   │   ├── PublishReviewModal.js
│   │   └── SignatureStatus.js
│   │
│   └── channels/
│       └── ChannelsPanel.js
│
├── torrent/
│   ├── TorrentPublishService.js
│   ├── TorrentSignaturePayload.js
│   └── SignedTorrentProtocol.js
```

---

## Current status

### Implemented

- Modularized peer web core
- Identity/Auth panel and flows
- Local encrypted wallet persistence (WebCrypto + IndexedDB)
- Deterministic publish payload + signing flow
- Publish-to-identity linkage in browser
- Signed torrent protocol (metadata embed + verification)
- Channels tab + swarm chat transport via WebTorrent wire extension

### Non-goals (still not implemented)

- Smart contracts
- Backend auth
- Token gating
- Multi-wallet management for signing
- Hardware wallet integration
- Cross-channel history persistence

---

## Quick start

```bash
npm install
npm run start
```

Open:

- `http://127.0.0.1:8000`

Type check:

```bash
npm run check
```

Build entrypoint:

```bash
npm run build
```

---

## Legacy P2P hosting behavior (still available)

- Drag/drop static website folder
- Generate torrent hash + shareable URL from an in-memory deploy bundle
- Keep tab open to continue seeding
- Load any site by hash using Browse/Load tab

---

## Debug mode

Append `debug=true` to URL:

```text
https://web25.cloud?orc=HASH&debug=true
```
