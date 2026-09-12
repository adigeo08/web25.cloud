# ☁️ WEB25.cloud

**Decentralized web platform for peer-to-peer static-site hosting + local EVM identity + signed torrent publishing + ephemeral HTTP mirrors + P2P direct messaging, fully in browser.**

WEB25.cloud is a [PeerWeb fork (`Omodaka9375/peerweb`)](https://github.com/Omodaka9375/peerweb) with identity-aware publishing and verification. It keeps the classic hash-based loading workflow while adding signed provenance, local passkey-protected keys, opportunistic GoFile mirrors for faster delivery, and direct encrypted peer messaging.

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
  - Create an ephemeral GoFile HTTP mirror by default; the option is preselected but can be unchecked before deploy
- **Pages**
  - One card per site this browser is seeding, with live peer and upload counters
  - Seeding survives a reload and resumes with the wallet still locked
  - Signing out never stops a session; only Stop seeding does, behind a confirmation
  - The tab appears only while at least one site is being hosted
- **Browse / Load**
  - Load by torrent hash or complete WEB25 URL
  - Resolution order: local cache → WebTorrent/P2P → GoFile mirror, when the link carries one
  - P2P gets one attempt with an 8-second deadline; there is no retry ladder
  - A quiet swarm transparently falls through to the mirror
  - Free-text search over the sites already cached in this browser — title, keywords, file names, publisher or hash prefix
- **Direct Messenger (WebRTC data channels + Nostr)**
  - Search a peer by Nostr `npub`, then start the chat — no magnet links, no key pasting
  - Encrypted invitations travel as NIP-59 gift wraps through public relays
  - Unknown peers are never auto-answered — their invitation waits for you to accept
  - Trusted contacts, encrypted with your wallet identity, reconnect directly
  - One connection indicator: `Connected · WebRTC` or `Connected · Nostr`, green either way
  - Identity-bound encrypted/signed message exchange
  - Nostr relay fallback when WebRTC cannot be established, for files as well as messages
  - Links in messages are clickable and open in a new tab; only `http(s)` is ever linked

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

### 6) Seeding that outlives the page

A deployment used to exist only for as long as the tab that made it. The payload was seeded from an in-memory bundle, so a reload ended the only copy of the site that existed, and `localStorage` held the signed `.torrent` but never the bytes — what came back after a refresh announced a deployment it could not serve.

The payload now lives in IndexedDB (`web25-seeding`), and the page re-seeds every stored session on start:

- Resuming needs **no key**: re-seeding is handing the same bytes back to WebTorrent, so it happens with the wallet locked
- The resumed torrent must hash to the same info hash — the stored name and piece length are what guarantee it — and is dropped rather than announced if it does not
- Signing out, clearing the site cache and staging the next deployment all leave live sessions alone
- A session ends when the publisher presses **Stop seeding** on its card in **Pages**, behind a confirmation; closing the tab only pauses it until the next visit
- The advanced-tools drawer that used to hold a "Clear Cache" button — and take every live deployment down with it — is gone from the Deploy page entirely

A finished deployment therefore leaves the Deploy page rather than settling on it. When a deployment completes the page clears itself and opens **Pages**, where that site's link, live peer and upload counters, deployment record and Stop seeding button are. The Deploy page is for deploying; a site that exists is managed where it lives.

**Pages** is gated on the wallet, exactly like **Chat**: with no identity unlocked the tab is not offered at all. The sites themselves go on seeding underneath — that is the whole point of the store — but managing them is the publisher's business.

What "saved" means here is deliberately strict, because the promise is that the site is still there on the next load:

- A write settles on the transaction's `complete`, never on the request. A successful `put` is not a durable write — IndexedDB reports the request inside the transaction, which can still abort afterwards — so a deployment is not treated as saved until it has committed, and an abort surfaces as a failure instead of being lost
- A torrent enters the live registry only after that commit: the registry is exempt from every teardown path, so a torrent whose payload was never stored would be one nothing could stop
- Writes for the same info hash are serialized. A mirrored deploy records itself twice in quick succession, and both calls read before they write; chained per hash, the second reads what the first wrote and the newest metadata wins without re-copying the payload
- Restoring runs a few sessions at a time rather than one after another, so a session that never calls back cannot hold the rest of start-up behind its timeout — and a torrent that arrives after that timeout is destroyed rather than left running untracked
- An owned torrent is followed to the end of its life: when one errors or closes, it leaves the registry and its card says so, rather than reading "Seeding" because an object is still in a `Map`
- Stopping is broadcast to this browser's other WEB25 tabs over a `BroadcastChannel`. IndexedDB is shared but the live torrents are not, so without it a site the publisher stopped would go on being served from a tab they were not looking at. Nothing leaves the browser; a browser without `BroadcastChannel` simply catches up on its next reload

Signed-but-not-yet-deployed artifacts are still kept in `localStorage` (`web25.deploy.session.v1`) so the deploy screen survives a refresh mid-flow.

---

### 6a) Session breadcrumb (`web25.session.tab.v1`)

The wallet session lives in the signing worker and dies with the page, by design. What the user should not also lose is their place, or an explanation.

A single `localStorage` entry records **which tab was open** and **whether a session was live** — no address, no public key, no npub, no hash, nothing derived from any of them. On the next load the tab is restored when it still exists, and the sign-in wall says the session ended with the page and needs unlocking again. It cannot unlock anything and cannot identify whose browser it is.

The two facts age separately, and for different reasons. The interrupted-session flag answers "did the page that just loaded take a live session with it", which is true of that load and of no later one, so it is read once and put down; moving between tabs no longer renews it, which it did while a single timestamp covered both. The remembered tab keeps its own timestamp and survives that.

What the user sees of this is four words. The sign-in wall reads **"You've been signed out."** and the button becomes **Unlock to Resume**; unlocking then returns them to the tab they were on. Only a first sign-in — nothing remembered at all — lands on Account instead.

```json
{ "tab": "publish", "tabSavedAt": 1762000000000, "wasUnlocked": true, "sessionAt": 1762000000000 }
```

---

### 6b) Ephemeral GoFile mirrors — cache → P2P → HTTP

GoFile is used as an optional **HTTP fallback transport**, not as the source of truth for a WEB25 deployment.

WebTorrent goes first because the swarm is what a deployment *is*: the torrent hash is its identity, and a visitor served from the mirror never becomes a peer. What P2P does not get is unlimited time — peer discovery either works within a few seconds or it does not, so the attempt is a single 8-second window (`P2P_ATTEMPT_TIMEOUT_MS`) with no retries. The mirror takes over the moment that window closes, an announce comes back empty, every tracker gives up, or the torrent errors.

For new deploys, the GoFile mirror option is **preselected by default** because it is what keeps a site reachable when nobody is seeding it. Publishers can explicitly uncheck it before deployment. This is a UX default, not a protocol requirement: deployment still succeeds without GoFile.

Preferred load order:

```text
local cache
    ↓ miss
WebTorrent / P2P          one attempt, 8 s
    ↓ no peer answered in time
GoFile mirror
```

A successful mirror load is cached normally, so later visits can load entirely from the local browser cache.

Each deployment can receive a separate GoFile mirror. Mirrors are treated as ephemeral because WEB25 relies on disposable guest accounts and makes no durability assumption about GoFile storage. Losing a mirror does not invalidate the deployment and does not prevent it from loading through WebTorrent.

The torrent hash remains the identity and integrity boundary. GoFile only changes how the bytes arrive. Mirror bytes are verified client-side against the included BitTorrent metainfo, expected info hash, file layout and BitTorrent v1 pieces before they enter the normal WEB25 verification/render path.

#### Local GoFile guest credential

Each unlocked WEB25 identity may hold one local GoFile guest token.

The token is never stored as plaintext. It inherits the existing wallet security boundary:

```text
WebAuthn PRF
    ↓
wallet vault / local wallet unlock
    ↓
dedicated wallet worker
    ↓
NIP-44 encrypt-to-self
    ↓
encrypted GoFile guest token in IndexedDB
```

The raw WebAuthn PRF output is never persisted, and the GoFile token is not encrypted directly with the PRF output. Instead, WebAuthn protects access to the local wallet, whose worker-backed Nostr identity encrypts the GoFile credential before persistence.

The credential is:

- scoped to the local WEB25 identity;
- reused while valid;
- replaced only when GoFile explicitly rejects it as invalid;
- never placed in WEB25 URLs;
- never logged or rendered in the UI;
- intentionally a disposable guest credential rather than a valuable Premium account.

A visitor without a readable local credential can use a temporary guest account for mirror retrieval without persisting it.

Browser-side GoFile reads pass through WEB25's GoFile Worker because the GoFile web download flow requires session/CORS handling that cannot be performed reliably from browser JavaScript alone. The Worker keeps no shared GoFile credential at rest; the client supplies its guest credential per request.

See [`docs/gofile-local-account-cdn.md`](docs/gofile-local-account-cdn.md) for the complete architecture and trust model.

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

### 8b) Consent, trusted contacts and presence

**A cryptographically valid offer is not consent.** Verifying a gift wrap proves
the sender is who they claim; it says nothing about whether you want to talk to
them, and anyone who knows your npub can produce a valid offer.

Answering is not free — it reveals your full ECIES public key, your EVM address,
and, through ICE gathering, your machine's network addresses. So an unknown peer
is never auto-answered:

- an invitation from anyone who is not an approved contact is **held**, and shown
  in a notifications area with their npub, profile name (best-effort), EVM
  address, trust state and timestamp
- this is where **first contact** arrives. A stranger cannot send an offer —
  that needs consent already given — so what they send is a chat request, and
  the request is what appears there with Accept and Decline. One person asking
  is enough; nobody has to guess that they should go and search for the other
- while it is held, `createAnswerPayloadFromRemoteOffer()` is not called, **no
  ICE is gathered**, no answer is sent and nothing is written to the contacts
  store
- **Accept** on an offer re-checks validity, expiry and the identity bindings,
  creates the answer, sends it over Nostr, and only then persists the peer as a
  trusted friend
- **Accept** on a request sends consent back — our own chat request — which
  makes the pair mutual and starts the handshake. There is no SDP in a request,
  so there is nothing to answer yet and nothing to verify yet; the identity
  tuple is checked when the offer arrives
- **Decline** discards the invitation: no answer, no connection, no contact. The
  peer is not notified, because that would confirm the npub is live, and every
  later request *or offer* from them is dropped in silence for the rest of the
  session, so a refusal cannot be worn down by repetition
- a request ages on the **sender's** clock, taken from the timestamp inside the
  sealed rumor. The inbox deliberately looks days back on every start, so
  without that a week-old request would be presented as a decision to make now;
  a timestamp in the future is clamped, so nobody can mint an invitation that
  never expires
- the count of waiting invitations also sits on the Direct Messenger tab, so an
  invitation that arrives while you are on another tab is still there when the
  toast has gone
- the gate **fails closed** — when trust cannot be determined (a locked wallet,
  say), the peer is unknown

Consent given in a session is remembered alongside the contacts, and it has to
be: after both sides agree, exactly one of them offers, and the other would
otherwise park that offer as a stranger's — both waiting, neither answering.
Saying yes to somebody, or asking them yourself, is consent to the reply you
just invited.

Trusted friends reconnect directly without asking again — their chat request is
consented to automatically, so a friend never lands in the invitation queue —
but every existing cryptographic check still runs, plus one more: the invitation's identity tuple
(Nostr pubkey ↔ ECIES key ↔ EVM address) must validate *and* match the stored
record. A matching contact record alone is never authorization, so somebody who
takes over an npub does not inherit the trust attached to it. Authorization sits
on top of authentication; it replaces none of it.

**Contacts are wallet-protected.** Records are encrypted at rest with your own
Nostr identity (NIP-44 v2 to self, through the existing wallet-worker
operations) — the same passkey/wallet protection the app already uses, not a
second password. IndexedDB holds `{ id, ownerTag, ciphertext, … }` and nothing
else: no peer key, no EVM address, no display name. **No private key, PRF output
or derived secret is persisted.** A locked wallet cannot read the list at all,
locking clears it from memory, and unlocking restores it.

The Friends list offers open, rename and remove. Removing is a local
authorization change only — the peer is unknown again and their next invitation
needs approval; **no key is deleted or rotated** on either side.

Presence is a separate state again:

```text
presence  ->  "reachable right now"   public, coarse, NIP-38 beacon
intent    ->  "I want to talk to you" private, gift-wrapped, one peer
consent   ->  "I will answer you"     local, explicit, never inferred
```

Selecting a contact or a search result sends a chat request only — no SDP, no
ICE, no handshake. Exactly one side offers, chosen deterministically so the two
never glare.

The side that does not offer has nothing to do but wait, and if the other has
closed their tab there is no failure to report — no connection was ever
attempted. So the wait is bounded: after twenty seconds the status goes back to
*waiting for them to accept* and says as much. Nothing is torn down, and the
invitation stays valid for its full lifetime, so the conversation still opens on
its own if they come back.

---

### 8c) One rendezvous relay

The client publishes to and subscribes on a single relay, `wss://nos.lol`.

Two browsers can only meet on a relay they both use. A pool spread over several
relays looks more robust and behaves worse: a gift wrap accepted by one relay
and a subscription that is healthy on another never meet, and the invitation is
lost with nothing reporting a failure — every relay involved answered `OK`. For
a first contact, where there is no retry loop and no existing session to fall
back on, that is the difference between reachable and not.

The cost is stated rather than hidden: while `nos.lol` is unreachable, the
Direct Messenger is unreachable with it — no invitations arrive and none can be
sent. The relay pool still does everything else it did — reconnect with backoff,
verify every event locally, deduplicate, drop malformed frames — and the list is
one array in `src/config/nostr.config.js`. Point it somewhere else,
including at a relay of your own, and every client sharing that list still finds
every other.

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
│   ├── SessionResumeHint.js
│   └── SigningService.js
├── cache/
│   ├── PeerWebCache.js
│   └── SiteLibraryIndex.js
├── channels/
│   ├── ChannelsService.js
│   ├── DirectMessageBootstrapCore.js
│   ├── DirectMessageTorrentBootstrap.js
│   ├── NostrDirectMessageBootstrap.js
│   ├── NostrDirectMessageSession.js
│   └── ecies.js
├── gofile/
│   ├── GoFileCredentialStore.js
│   ├── GoFileMirrorCodec.js
│   ├── GoFileService.js
│   └── Web25Url.js
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
│       ├── PreferredSiteLoader.js
│       ├── SeedingSessionStore.js
│       ├── SeedingSessions.js
│       └── TorrentLoader.js
├── ui/
│   ├── auth/
│   ├── browse/
│   ├── pages/
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
- Nostr rendezvous relay (configurable in `src/config/nostr.config.js`): `wss://nos.lol`
  — one relay on purpose, so two Web25 browsers always share one; see §8c
- GoFile: optional ephemeral HTTP mirror for static deployments; preselected by default in the deploy UI and user-disableable
- WEB25 GoFile transport Worker: `https://gofile-cf-downloader.carlgray.workers.dev`
  — used only as the browser-to-GoFile transport adapter; torrent verification remains client-side

---

## Future goals (not implemented yet)

1. Own WebTorrent tracker
2. Own Nostr infrastructure
3. Migrating from GoFile to Sia Network
4. Encrypted static-site content
5. Decryption-key unlock via atomic-swap payment flow

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
