# ☁️ Web25.Cloud

**Decentralized web platform for peer-to-peer static site hosting + local in-browser signing + signed torrent publishing + P2P direct messaging, fully in-browser.**

Web25.Cloud extends PeerWeb with a modular architecture and an identity-aware publishing flow.

---

## What is implemented now

### 1) Clear UI split (Identity / Publish / Direct Messenger / Browse)

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
- **P2P Direct Messenger (WebRTC data channels)**
  - Host/guest offer-answer workflow (manual signaling codes)
  - ICE discovery via public STUN (`stun:stun.l.google.com:19302`)
  - Peer count updates in real time
  - Send/receive signed identity-tagged messages over direct data channel
  - Per-session chat stream in dedicated Direct Messenger tab

### 2) Local browser wallet — WebAuthn passkey protected (viem + local-data-lock + IndexedDB)

Local identity supports:

- Register local wallet with device passkey (FaceID / TouchID / PIN)
- Generate and show seed phrase once (BIP-39, for recovery)
- Add alternate passkeys to same wallet (e.g. FaceID + TouchID)
- Unlock wallet via biometric prompt — no password needed
- Lock session manually at any time
- Delete local wallet (removes passkey + IndexedDB record)
- Fallback to legacy AES-GCM when WebAuthn unavailable

Stored wallet metadata in IndexedDB (`web25-auth`, v2):

- `walletId`
- `address`
- `encryptedBlob` ← libsodium-encrypted private key (replaces `encryptedPrivateKey` + `iv`)
- `localIdentityID` ← passkey account reference (non-secret)
- `createdAt`
- `lastUsedAt`

#### Security model

Private key is protected by a hardware-backed passkey:

1. `@lo-fi/local-data-lock` generates a cryptographic keypair tied to a WebAuthn passkey.
2. The wrapping key **never touches IndexedDB** — it lives in the device's secure enclave / TPM.
3. Private key is encrypted with libsodium using the passkey-derived lock key.
4. Encrypted blob is stored in IndexedDB.
5. To decrypt, the user must authenticate via device biometric / PIN — every session.
6. The lock key is cached in memory for 30 minutes after authentication (configurable).
7. Private key is available in JS memory only for the duration of signing operations.

> **Zero-change impact on signing and messaging flows**: `signWithLocalWallet()`,
> `eciesEncrypt()`, `eciesDecrypt()`, and `signMessage()` all consume `unlockedPrivateKey`
> from memory — unchanged. Only how the key reaches memory has changed.

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

### 7) P2P Direct Messenger over WebRTC

Direct Messenger follows a manual offer/answer handshake flow with **ECIES asymmetric encryption** on secp256k1 (the EVM curve):

- host generates an offer code containing their EVM address + secp256k1 public key and shares it out-of-band
- guest verifies the host's identity (`publicKey → keccak256 → address`) before accepting
- guest generates an answer code with their own EVM address + public key
- host applies the answer, verifies guest identity, and the WebRTC data channel opens
- STUN server (`stun:stun.l.google.com:19302`) is used for ICE candidate discovery
- every outbound message is **encrypted with the recipient's secp256k1 public key** (ECIES) and **signed with the sender's private key** (ECDSA)
- every inbound message is **decrypted with own private key** then **signature-verified** against the peer's public key; invalid signatures are rejected with an error event
- identity is verified **built-in at connect time**: `🪪 Peer verified: 0xABC...1234` system message appears for both sides
- no shared symmetric key — each peer only needs their own private key and the peer's public key
- UI renders message timeline, local-vs-remote message markers, and live peer count

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
│   ├── SecureKeyStore.js      ← passkey-backed (replaces AES-GCM wrapping key)
│   └── SigningService.js
│
├── vendor/
│   └── local-data-lock/       ← @lo-fi/local-data-lock dist/auto (new)
│
├── cache/
│   └── PeerWebCache.js
│
├── channels/
│   ├── ChannelsService.js
│   └── ecies.js
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
- Direct Messenger tab + direct WebRTC data channel transport
- WebAuthn passkey-protected wallet encryption (`@lo-fi/local-data-lock`)
- Multi-passkey support (add FaceID + TouchID as alternates)
- Biometric session cache with manual lock
- Legacy wallet migration flow (seed phrase → passkey upgrade)

### Non-goals (still not implemented)

- Smart contracts
- Backend auth
- Token gating
- Multi-wallet management for signing
- Hardware wallet integration (Ledger/Trezor)
- Cross-room history persistence
- ~~Hardware wallet integration~~ → parțial acoperit de WebAuthn passkeys

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
