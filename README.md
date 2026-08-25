# ☁️ WEB25.cloud

**Decentralized web platform for peer-to-peer static-site hosting + local EVM identity + signed torrent publishing + P2P direct messaging, fully in browser.**

WEB25.cloud is a [PeerWeb fork (`Omodaka9375/peerweb`)](https://github.com/Omodaka9375/peerweb) with identity-aware publishing and verification. It keeps the classic hash-based loading workflow while adding signed provenance, local passkey-protected keys, and direct encrypted peer messaging.

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
  - Separate mode to search the public WEB25 website registry over Nostr/DTAN
- **Direct Messenger (WebRTC data channels + Nostr)**
  - Search a peer by Nostr `npub`, then start the chat — no magnet links, no key pasting
  - Encrypted invitations travel as NIP-59 gift wraps through public relays
  - Transport state shown plainly: `P2P · WebRTC` or `Relay fallback · Nostr`
  - Identity-bound encrypted/signed message exchange
  - Nostr relay fallback when WebRTC cannot be established

### 2) Local browser wallet — WebAuthn passkey protected (viem + PasskeyVault + IndexedDB)

Local identity supports:

- Register local wallet with device passkey (Face ID / Touch ID / PIN)
- Generate and reveal seed phrase once (BIP-39 recovery)
- Add alternate passkeys on the same wallet
- Unlock via biometric/device authenticator (no password)
- Manually lock session anytime
- Delete local wallet state from browser storage
- No fallback unlock path: without WebAuthn PRF support the wallet cannot be created or opened

Stored metadata in IndexedDB (`web25-auth`, v2):

- `walletId`
- `address`
- `encryptedBlob`
- `credentialId`
- `vaultId`
- `vaultVersion`
- `createdAt`
- `lastUsedAt`

#### Security model

1. `PasskeyVault.js` derives the vault key from the **WebAuthn PRF extension**
   (`extensions.prf`) via HKDF-SHA256. `user.id` is a random, non-secret handle
   and `response.userHandle` is never read back.
2. The PRF secret is never persisted. localStorage holds only non-secret
   credential metadata: the PRF salt, the HKDF salt, and the vault key wrapped
   under the PRF-derived KEK.
3. Each enrolled passkey wraps the same vault key under its own KEK, so several
   passkeys can unlock one wallet.
4. Decryption requires a user-verified WebAuthn assertion; there is no fallback
   unlock path. An authenticator without PRF fails explicitly.
5. The decrypted private key is transferred to a **dedicated worker**
   (`src/auth/wallet-worker.js`) and the main-thread reference is dropped
   immediately. No API returns the key: callers ask the worker for
   `SIGN_MESSAGE`, `ECIES_SIGN`, `ECIES_DECRYPT` or `GET_PUBLIC_KEY`.
6. The worker session has a 30-minute TTL/inactivity timeout; `LOCK`, worker
   termination and page reload all leave the wallet locked. The service worker
   holds no wallet state.

> **Wallets created before the PRF vault cannot be unlocked.** They are detected
> and reported as needing migration; recover them from the seed phrase.

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

#### Verification policy

- **Strict (default):** `REQUIRE_TORRENTCHAIN = true`
  - missing, malformed, or invalid `.torrentchain` blocks load/render

#### Site isolation

`.torrentchain` proves **provenance, not privilege**. A site signed by a
malicious publisher is still untrusted code, so verification gates *whether* a
site renders, never *what it may do*.

- The site renders in a sandboxed `iframe` **without `allow-same-origin`**, so
  it executes in an opaque origin: no access to the wallet's IndexedDB, the
  Web25 `localStorage`, the signing worker, service-worker messaging, the
  application's auth/signing functions, or the Web25 DOM.
- Bundle files reach the frame over one `MessagePort` whose operations are
  allowlisted in `src/core/renderer/SandboxBridgeProtocol.js`
  (`sandbox.ready`, `resource.get`, `site.title`, `site.log`). Origin, source
  window, session token, message type and payload shape are all checked. No
  signing or wallet operation is exposed.
- Inside the frame, files are materialised as blob URLs and static references,
  CSS `url()` / `@import`, `fetch` and `XHR` are remapped, so relative paths,
  stylesheets and scripts keep working.
- `/peerweb-site/` responses from the service worker additionally carry
  `Content-Security-Policy: sandbox …`, so even a direct navigation to that path
  lands in an opaque origin.

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

Direct Messenger binds every peer to an EVM identity with asymmetric crypto on secp256k1:

- offers and answers carry mandatory `evmAddress` + `publicKey`
- each side verifies the other (`publicKey → keccak256 → address`) before any message
- DM setup requires an unlocked local wallet on both peers
- STUN used for ICE discovery: `stun:stun.l.google.com:19302`
- outbound messages are always encrypted for recipient (ECIES) + signed by sender
- inbound messages are always decrypted locally + signature-verified
- invalid signatures are rejected
- no plaintext DM fallback is allowed

---

### 8) Nostr identity, signalling and relay fallback

One local secp256k1 key backs three identities — EVM, ECIES and Nostr — with no
second seed and no second private key:

```text
local wallet private key (dedicated worker only)
   ├─ EVM identity     0x…
   ├─ ECIES identity   04…
   └─ Nostr identity   npub1…
```

The Identity page shows all three side by side, each with its own copy button.
The Nostr section carries its own **Add / Delete Nostr Identity** action, while
Lock / Delete Wallet / Add Passkey stay grouped with the wallet status.

Add and Delete control *reachability*, not a key: deleting unsubscribes the
gift-wrapped inbox and hides the address, adding it back derives the same
`npub`. Only the string `on`/`off` is persisted per wallet in `localStorage` —
no key material. It cannot make an already-shared `npub` unknowable.

- conversations start by searching a recipient `npub` (a raw hex key works too);
  the pool is asked for a public kind-0 profile so the user can confirm the peer
  before starting, but a missing profile never blocks messaging
- the encrypted WebRTC offer/answer travel as NIP-59 gift wraps through a
  configurable pool of public relays, straight from the browser
- SDP, ICE data, EVM address and ECIES key are never publicly readable
- WebRTC stays the preferred transport; the relay path is used only when a
  connection cannot be established, and WebRTC is preferred again as soon as the
  DataChannel reopens
- fallback messages keep the existing Web25 signed + ECIES envelope *and* add
  NIP-44 on top; relays are just another untrusted pipe
- Nostr private-key operations happen inside the wallet worker and fail when the
  wallet is locked; no `nsec` is ever produced or persisted

NIPs used: **NIP-01**, **NIP-19**, **NIP-44 v2**, **NIP-59**, **NIP-17**.
NIP-04 is not implemented. See `docs/nostr-direct-messenger.md`.

---

### 9) Public WEB25 website registry (NIP-35 / DTAN)

A second, separate Nostr use case. Every deployed website can also be published
as a public NIP-35 torrent event, so WEB25 sites become discoverable:

```text
Direct Messenger  ->  private signalling + encrypted fallback (NIP-17/44/59)
Registry          ->  public website discovery (NIP-35 kind 2003)
```

- category is exactly `tcat:web25.cloud,websites` (`WEB25.cloud / Websites`)
- the event carries the final BitTorrent infohash, the real torrent entries and
  the real tracker list
- the existing `.torrentchain` EVM proof is mirrored into the event, so a
  browser can show `Verified publisher: 0x...` before downloading
- **no second EVM signature**: the site was already signed when
  `.torrentchain` was created; only a Nostr signature is added
- registry relays default to `wss://relay.dtan.xyz` plus the generic relays;
  no single relay is authoritative
- registry publication never blocks or invalidates a deployment, and a retry
  resubmits the identical signed event (same id, `created_at` and signature)

Trust model:

```text
DTAN / Nostr        -> tells users that a website exists
BitTorrent infohash -> identifies the distributed artifact
.torrentchain       -> proves the contents and the publisher
EVM signature       -> proves the WEB25 publisher identity
Nostr signature     -> proves who published the registry entry
```

Registry metadata is an early signal only. The final load path is unchanged:
download, read `.torrentchain`, verify the EVM signature and bundle hash, then
render in the sandbox. See `docs/web25-nostr-registry.md`.

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
│   ├── DirectMessageBootstrapCore.js
│   ├── DirectMessageTorrentBootstrap.js
│   ├── NostrDirectMessageBootstrap.js
│   ├── NostrDirectMessageSession.js
│   └── ecies.js
├── registry/
│   ├── Web25RegistryEvent.js
│   └── Web25RegistryService.js
├── nostr/
│   ├── NostrIdentityPreference.js
│   ├── NostrProfileLookup.js
│   ├── NostrRelayPool.js
│   ├── bech32.js
│   ├── nip19.js
│   ├── nip59.js
│   ├── nostr.js
│   └── nostrCore.js
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

In short: WEB25.cloud is built on top of the upstream `Omodaka9375/peerweb` fork and extends it with identity-bound signing/messaging capabilities.

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
- Nostr relays (configurable in `src/config/nostr.config.js`):
  - Direct Messenger: `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`, `wss://relay.snort.social`
  - Website registry: `wss://relay.dtan.xyz` plus the relays above

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
