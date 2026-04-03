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

### 3) Deterministic publish signing payload + signed site verification

Torrent publish signature payload is deterministic and serialized predictably.

Fields used:

- `torrentHash`
- `siteName`
- `createdAt`
- `version`
- `publisherAddress`
- `contentRoot`
- `chainId`

Signing/publish flow:

1. User drops/selects site files
2. App builds an in-memory normalized bundle (browser memory only)
3. App creates a torrent from that memory bundle and keeps a publish candidate (hash + site metadata)
4. App generates a signed manifest (`.torrentchain`) and prompts wallet signing
5. User signs payload with active local identity
6. `.torrentchain` is included at the root of the seeded bundle

#### `.torrentchain` protocol (recommended verification path)

Published sites include a small root file named **`.torrentchain`** which contains:

- a signed publisher payload (publisher address, chain id, timestamps, etc.)
- optional bundle metadata (`bundle.name`, `bundle.sha256`, `bundle.contentEncoding`, `bundle.schema`) when gzip bundle mode is enabled
- file listing semantics metadata (`filesSemantics`) to disambiguate whether file hashes describe torrent entries or bundle contents

At load time (Browse/Load by hash), the client:

- reads `.torrentchain` first (when present)
- verifies the publisher signature before rendering
- enforces a minimal integrity gate (pre-render)

#### Verification policy / backward compatibility

Verification behavior is controlled by config:

- **Permissive (default)**: `REQUIRE_TORRENTCHAIN = false`
  - if `.torrentchain` is missing, the site is still allowed to load, but is flagged as **Orphan** (signature not verifiable)
- **Strict**: `REQUIRE_TORRENTCHAIN = true`
  - if `.torrentchain` is missing or invalid, the site load is blocked

---

### 4) Site bundle modes (multi-file vs gzip single-file)

By default, published torrents may include many individual files. An optional “single-file bundle” mode is also available to avoid partial/fragmented caching issues for large sites.

Bundle mode is controlled by:

- `PEERWEB_CONFIG.SITE_BUNDLE_MODE = 'files' | 'gzip'` (default: `'files'`)

#### `SITE_BUNDLE_MODE = 'files'` (default)

- Seeds the site as multiple files in the torrent.
- Best-effort early processing may render before 100% download.
- Cache may store partial site data in early-processing scenarios.

#### `SITE_BUNDLE_MODE = 'gzip'` (optional)

- Seeds the payload as a **single** gzip bundle file:
  - `site.bundle.json.gz` (atomic site payload)
  - plus `.torrentchain` (small, separate, prioritized)

Loader flow (gzip mode):

1. verify `.torrentchain` signature (when present)
2. download `site.bundle.json.gz`
3. decompress and compute SHA-256 of canonical decompressed bytes
4. compare to `.torrentchain.payload.bundle.sha256`
5. reconstruct full `siteData` in memory
6. cache and render

Notes:

- Gzip mode requires browser support for `CompressionStream` / `DecompressionStream`.
- If gzip mode is requested but streams are unavailable, the app falls back to `'files'` mode and warns the user.
- In permissive mode, if `.torrentchain` is missing, gzip loads are treated as **Orphan gzip bundle** (bundle hash not verifiable).

---

### 5) Signature state persistence (cache stability)

To prevent verified sites from regressing back to “pending” after reload, the cache stores `signatureState` alongside the cached `siteData`.

- On cache hit, the loader reapplies `signatureState` so the UI badge remains stable.
- The stored state is versioned (`verificationVersion`). If the version changes, the loader may mark the cached state as stale and recommend revalidation.

---

### 6) Signed deploy session persistence (refresh-safe)

- Signed deploy artifacts are persisted in `localStorage` under `web25.deploy.session.v1`
- On refresh, Web25.Cloud restores signing/deploy UI state and re-adds the signed torrent to WebTorrent
- This enables continuing seeding/redeploy flows without repeating sign steps in normal scenarios
- WebTorrent runtime script is loaded from:
  - `https://cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js`

---

### 7) Channels over WebTorrent peer wires

Channels are implemented as deterministic swarms derived from channel names:

- channel names are normalized and hashed into stable info hashes
- each channel is joined as a lightweight magnet swarm
- chat payloads are exchanged through a custom extension (`web25_channels_v1`)
- UI renders message timeline, local-vs-remote message markers, and live peer count
- identity address (when available) is included in message metadata
- system payloads are supported (e.g. signature verification abort notifications)

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
├── cache/
│   └── PeerWebCache.js
│
├── channels/
│   └── ChannelsService.js
│
├── core/
│   ├── cache/
│   │   └── SignatureStateVersion.js
│   └── torrent/
│       └── TorrentLoader.js
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
└── torrent/
    ├── RenderGate.js
    ├── SiteBundleCodec.js
    ├── TorrentChainProtocol.js
    ├── TorrentPublishService.js
    ├── TorrentSignaturePayload.js
    └── SignedTorrentProtocol.js
```

---

## Current status

### Implemented

- Modularized peer web core
- Identity/Auth panel and flows
- Local encrypted wallet persistence (WebCrypto + IndexedDB)
- Deterministic publish payload + signing flow
- Publish-to-identity linkage in browser
- `.torrentchain` protocol (signed manifest + verification gate before render)
- Optional gzip single-file site bundle mode (`site.bundle.json.gz`)
- Signature-state persistence in cache (stable verified badge on reload)
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

## Configuration flags

The main behavior toggles live in `src/config/peerweb.config.js`:

- `REQUIRE_TORRENTCHAIN`:
  - `false` (default): permissive legacy/orphan support
  - `true`: block loads without valid `.torrentchain`
- `SITE_BUNDLE_MODE`:
  - `'files'` (default): multi-file torrents
  - `'gzip'`: seed `site.bundle.json.gz` + `.torrentchain` and validate bundle hash pre-render

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
