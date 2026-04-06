# ☁️ Web25.Cloud

**Decentralized web platform for peer-to-peer static-site hosting + local EVM identity + signed torrent publishing + P2P direct messaging, fully in browser.**

Web25.Cloud is a [PeerWeb fork (`Omodaka9375/peerweb`)](https://github.com/Omodaka9375/peerweb) with identity-aware publishing and verification. It keeps the classic hash-based loading workflow while adding signed provenance, local passkey-protected keys, and direct encrypted peer messaging.

---

## What is implemented now

### 1) Clear product split (Identity / Publish / Direct Messenger / Browse)

The UI is organized into:

- **Identity / Auth**
  - Register local wallet
  - Unlock local wallet
  - Recover from seed phrase
  - Lock/disconnect session
  - Delete local wallet
- **Publish**
  - Select/drop files
  - Build in-memory bundle
  - Create torrent from bundle
  - Preview signing payload
  - Sign payload with local EVM identity
  - Seed signed output
- **Browse / Load**
  - Existing torrent hash loading flow remains available
- **Direct Messenger (WebRTC data channels)**
  - Manual host/guest offer-answer signaling
  - Peer count and session state updates
  - Identity-bound encrypted/signed message exchange

### 2) Local browser wallet — WebAuthn passkey protected (viem + PasskeyVault + IndexedDB)

Local identity supports:

- Register local wallet with device passkey (Face ID / Touch ID / PIN)
- Generate and reveal seed phrase once (BIP-39 recovery)
- Add alternate passkeys on the same wallet
- Unlock via biometric/device authenticator (no password)
- Manually lock session anytime
- Delete local wallet state from browser storage
- Legacy fallback path when WebAuthn is unavailable

Stored metadata in IndexedDB (`web25-auth`, v2):

- `walletId`
- `address`
- `encryptedBlob`
- `credentialId`
- `encPKStored`
- `createdAt`
- `lastUsedAt`

#### Security model

1. `PasskeyVault.js` derives passkey-bound encryption material from WebAuthn flows.
2. Signing key material is sealed before persistence.
3. Only encrypted key blob + non-secret metadata are persisted.
4. Decryption requires WebAuthn assertion on new sessions.
5. Decrypted private key is memory-resident only during unlock/sign operations.

---

### 3) Deterministic publish payload + `.torrentchain` verification path

Publish signing payload is deterministic and stable.

Fields currently used:

- `torrentHash`
- `siteName`
- `createdAt`
- `version`
- `publisherAddress`
- `contentRoot`
- `chainId`

Publish flow:

1. User selects site files.
2. App normalizes content in memory.
3. App creates torrent publish candidate (hash + metadata).
4. App generates `.torrentchain` and requests signature.
5. User signs with active local identity.
6. `.torrentchain` is included at the torrent root.

#### `.torrentchain` protocol (recommended verification path)

Published sites include root file **`.torrentchain`** containing:

- signed publisher payload (publisher address, chain ID, timestamps, etc.)
- optional bundle metadata (`bundle.name`, `bundle.sha256`, `bundle.contentEncoding`, `bundle.schema`) in bundled mode
- `filesSemantics` metadata to disambiguate hash semantics for torrent entries vs bundle contents

At load time, the client:

- reads `.torrentchain` first (when present)
- verifies signature before render
- applies integrity gate checks prior to rendering

#### Verification policy / backward compatibility

- **Permissive (default):** `REQUIRE_TORRENTCHAIN = false`
  - missing `.torrentchain` can still load, flagged as **Orphan**
- **Strict:** `REQUIRE_TORRENTCHAIN = true`
  - missing/invalid `.torrentchain` blocks load

---

### 4) Site bundle modes (multi-file vs gzip single-file)

Bundle mode is controlled by:

- `PEERWEB_CONFIG.SITE_BUNDLE_MODE = 'files' | 'gzip'`
- **Current default in this fork:** `'gzip'`

#### `SITE_BUNDLE_MODE = 'files'`

- Seeds many files directly in torrent
- May render with early processing before full completion
- Cache behavior can reflect partial early-processing states

#### `SITE_BUNDLE_MODE = 'gzip'` (default)

- Seeds single payload file:
  - `site.bundle.json.gz`
  - plus `.torrentchain`

Loader flow in gzip mode:

1. Verify `.torrentchain` signature (if present)
2. Download `site.bundle.json.gz`
3. Decompress and compute SHA-256 of canonical bytes
4. Compare with `.torrentchain.payload.bundle.sha256`
5. Reconstruct `siteData` in memory
6. Cache + render

Notes:

- Gzip flow needs `CompressionStream` / `DecompressionStream` browser support
- If unsupported, app can fallback to files mode
- In permissive mode, missing `.torrentchain` is marked as orphan gzip bundle

---

### 5) Signature-state persistence (cache stability)

To avoid regressions from verified → pending after refresh:

- cache stores `signatureState` together with `siteData`
- loader reapplies cached `signatureState` on cache hit
- state includes `verificationVersion` for stale-state detection/revalidation

---

### 6) Signed deploy session persistence (refresh-safe)

- Signed deploy artifacts are persisted in `localStorage` (`web25.deploy.session.v1`)
- On refresh, UI/deploy state can be restored and reseeded
- Helps continue normal seeding/deploy flow without repeating steps

---

### 7) P2P Direct Messenger over WebRTC (identity-bound)

Direct Messenger follows manual offer/answer signaling with asymmetric crypto on secp256k1:

- host creates offer with EVM address + public key
- guest verifies host identity (`publicKey → keccak256 → address`)
- guest replies with answer carrying own identity
- host verifies guest identity and opens data channel
- STUN used for ICE discovery: `stun:stun.l.google.com:19302`
- outbound messages are encrypted for recipient + signed by sender
- inbound messages are decrypted locally + signature-verified
- invalid signatures are rejected

---

## Security profile (current)

### HTML sanitization (DOMPurify)

Rendered HTML is sanitized with DOMPurify at load time, using a compatibility-oriented profile:

- allows additional tags: `link`, `style`, `script`
- allows extended attrs: `srcset`, `integrity`, `crossorigin`, etc.
- allows broader protocols: `magnet`, `ipfs`, `ipns`, `blob`, `data`, etc.

This is an explicit trade-off: better static-site compatibility vs stricter sanitization defaults.

### Identity + signature gates

- Publisher signature checks run before render when `.torrentchain` is present
- In strict mode, invalid/missing `.torrentchain` blocks site load

---

## Architecture (modular)

```text
src/
├── auth/
│   ├── AuthController.js
│   ├── AuthState.js
│   ├── LocalWalletService.js
│   ├── SeedPhraseService.js
│   ├── PasskeyVault.js
│   ├── SecureKeyStore.js
│   └── SigningService.js
├── cache/
│   └── PeerWebCache.js
├── channels/
│   ├── ChannelsService.js
│   └── ecies.js
├── core/
│   ├── cache/
│   │   └── SignatureStateVersion.js
│   └── torrent/
│       └── TorrentLoader.js
├── ui/
│   ├── auth/
│   ├── publish/
│   └── channels/
└── torrent/
    ├── RenderGate.js
    ├── SiteBundleCodec.js
    ├── TorrentChainProtocol.js
    ├── TorrentPublishService.js
    ├── TorrentSignaturePayload.js
    └── SignedTorrentProtocol.js
```

---


## Upstream credits and how Web25 integrates them

### 1) [`Omodaka9375/peerweb`](https://github.com/Omodaka9375/peerweb)

What it provides:

- the upstream PeerWeb browser-native architecture;
- hash-based browse/load workflow;
- foundational torrent publishing and rendering model.

How Web25 builds on this fork base:

- preserves the original PeerWeb flow for loading by hash;
- extends publishing with signed `.torrentchain` provenance and integrity checks;
- adds local EVM identity and direct peer messaging while keeping the upstream spirit.

In short: Web25.Cloud is built on top of the upstream `Omodaka9375/peerweb` fork and extends it with identity-bound signing/messaging capabilities.

### 2) [`mylofi/local-data-lock`](https://github.com/mylofi/local-data-lock)

What it demonstrates:

- local-first key custody model;
- WebAuthn/passkey-gated key unlock flow;
- no requirement to expose private keys outside the local environment.

How Web25 integrates this into the EVM process:

- we keep EVM private-key custody fully local;
- WebAuthn passkeys gate unlock/signing sessions;
- once unlocked, the key is used by our EVM signing/encryption paths (publish signatures, channel signing) and then cleared from active session memory.

In short: we adopted the local-data-lock *security posture* and mapped it onto EVM identity/signing workflows.

### 3) [`michal-wrzosek/p2p-chat`](https://github.com/michal-wrzosek/p2p-chat)

What it demonstrates:

- simple manual offer/answer WebRTC signaling UX;
- direct browser-to-browser chat transport;
- minimal coordination flow without centralized chat backend.

How Web25 integrates and extends this for EVM:

- we kept the manual P2P signaling ergonomics;
- we bind peers to EVM identity and verify identity from public key to address;
- we use asymmetric encryption/signature flows around EVM-compatible key material, so private keys are never publicly disclosed.

In short: we borrowed the direct-messaging interaction model and upgraded it to identity-bound EVM cryptography.

---

## Public infrastructure currently used

- WebTorrent tracker: `wss://tracker.openwebtorrent.com/`
- STUN: `stun:stun.l.google.com:19302`

---

## Future goals (not implemented yet)

1. Own WebTorrent tracker
2. Own STUN/TURN infra
3. Encrypted static-site content
4. Decryption-key unlock via atomic-swap payment flow

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

Build:

```bash
npm run build
```

---

## Debug mode

Append `debug=true` to URL:

```text
https://web25.cloud?orc=HASH&debug=true
```

---

## License

Apache-2.0.
