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
  - **Stop seeding** takes a site off the air and keeps its card, with **Resume seeding** in its place; **Delete website** removes the card and the session. Both ask first
  - Sites reseeded from somebody else's link sit here too, marked **Reseeded** and credited to their own publisher; one of your own put back from a copy reads **Restored**, because the signature in it is still yours
  - Signing out never stops a session
  - The tab appears only while at least one site is being hosted
- **Browse / Load**
  - Load by torrent hash or complete WEB25 URL
  - Resolution order: local cache → WebTorrent/P2P → GoFile mirror, when the link carries one
  - P2P gets one attempt with an 8-second deadline; there is no retry ladder
  - A quiet swarm transparently falls through to the mirror
  - One checkbox under the box — **Search local cached history** — turns it from an address bar into a search over the sites already cached in this browser — title, keywords, file names, publisher or hash prefix — and the results read as search results. Nothing is listed until something is searched for, and no query leaves the device
  - The strip above a rendered site carries **Back** and the two things a visitor can decide: one control that is both the signature verdict and the offer to host (**✔ Reseed** when the publisher checks out, **⚠ Unverified** when nobody has vouched for the bytes), and **Delete data**
- **Direct Messenger (Nostr + WebRTC data channels)**
  - Search a peer by Nostr `npub`, then start the chat — no magnet links, no key pasting
  - Encrypted invitations travel as NIP-59 gift wraps through public relays
  - Unknown peers are never auto-answered — their invitation waits for you to accept
  - Saved contacts, encrypted with your wallet identity, are a persistent messenger: one
    room per pair, messages over Nostr any time, held encrypted and marked unread while
    their chat is closed — and a direct WebRTC link only while both of you have it open
  - One connection indicator: `Connected · WebRTC` or `Connected · Nostr`, green either way
  - Identity-bound encrypted/signed message exchange
  - Nostr carries messages and files whenever there is no direct link
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
- **Stop seeding** on a card in **Pages** takes that site off the air and marks the record paused: the card stays, offering **Resume seeding**, and a reload leaves it paused rather than quietly starting it again
- **Delete website**, the separate button next to it, removes the session and the card: this browser stops serving the site, across reloads. It is not the end of the site here — while a copy is still cached, **Reseed** on the site itself puts it back on the air, and **Delete data** is what leaves nothing. All of these ask first, and they ask different questions
- Closing the tab only pauses a session until the next visit
- The advanced-tools drawer that used to hold a "Clear Cache" button — and take every live deployment down with it — is gone from the Deploy page entirely

A finished deployment is shown in both places, for two different reasons. The Deploy page keeps the result — the WEB25 link, how it is being served, the mirror row, who signed it and the `.torrent` to download — as the receipt for what just happened, and **Deploy another site** clears it away for good when the publisher is done with it (a real reset: staged files, signature and saved session all go). The deployment itself is handed to **Pages**, which the page opens as soon as it completes, with that site's card already expanded — Pages is where its live peer and upload counters, its deployment record and its Stop seeding / Delete website buttons are. Cards there are newest first.

A publisher's own deployments in **Pages** are gated on the wallet, exactly like **Chat**: with no identity unlocked those cards are not offered. The sites themselves go on seeding underneath — that is the whole point of the store — but managing a deployment is the publisher's business. Sites *reseeded* from here are the exception, and have to be: starting to host somebody else's site needs no identity, so stopping must not need one either, and the card that stops it stays reachable.

### 6b) Reseeding somebody else's site, and forgetting one

The strip above a rendered site is the only WEB25 UI on screen while a peer-hosted page is up, so it carries only things a visitor can act on. The hash and the transport label that used to sit there ("From Cache" / "Fresh Download") were facts about the load rather than about the site, and on a phone they were what pushed the buttons off the row. What took that room:

- **✔ Reseed / ⚠ Unverified** — one control, because the signature and the offer to host are one question: whether to put this browser's bandwidth behind somebody else's bytes. When the publisher's `.torrentchain` signature verifies it reads **✔ Reseed** and your browser joins the swarm serving the site; when nothing could be verified it reads **⚠ Unverified** and offers nothing at all. Once the site is being served from here the mark becomes **✅ Seeding**, and **🔄 Resume seeding** for one stored but off the air — at that point the signature is settled and what the strip should report is whether your browser is serving the page in front of you. Only those two states may take the mark, because neither is reachable without a verified signature. The wording a glyph cannot carry stays in the button's `title` and `aria-label`, verdict first
- **Delete data** — asks first, then erases everything this browser keeps about that site: seeding stops, the stored payload and the cached copy go, and it stops turning up in the search box. The same button and the same promise whether the site was deployed from here or only visited. The site itself is untouched — other peers and any mirror go on serving it

A reseeded site keeps its author, its signature, its date and its link. It appears in **Pages** credited to the publisher who signed it rather than to whoever reseeded it; stop, resume and delete work on it exactly as on a site deployed here.

Whose site it is and how this browser came to hold it are two questions with two answers, and the card gives both. A reseed of somebody else's page makes you its **Host**, marked **Reseeded**. A reseed of *your own* — a deployment you lost, put back from a copy this browser kept — leaves you its **Publisher**, marked **Restored**, because the signature inside it is yours: the card compares the signing address with the unlocked identity (case-insensitively, since one tool checksums an address and another does not) rather than assuming anything reseeded belongs to a stranger. The comparison happens per render, so signing in later is what makes it knowable; with nobody signed in the browser has no identity to recognise and says so.

Reseeding is byte-exact or it does not happen. The info hash *is* the site's address, so what gets announced has to be the payload as it travelled, not the site as it renders — in bundle mode those are different things, since one gzip file on the wire unpacks into the whole site. So the wire entries and the `.torrent` are kept, checked against the info dictionary on the way into storage and again on the way out, and the re-seeded torrent's info hash is compared against the link's before anything is announced. A mismatch is refused and leaves no card behind.

The **GoFile mirror locator** travels with the payload, because it is part of the site's address rather than of whichever load noticed it. Most loads do not: somebody opening a bare hash tomorrow knows nothing about the mirror today's link carries. So a load that does resolve one records it against the payload already held (and never writes one for a site this browser does not keep — noticing a mirror is not a reason to start keeping a site), a write that knows of no mirror does not erase one that is known, and a reseed restores the whole WEB25 link, mirror and all, reporting the mirror as present instead of "Not created — WebTorrent only".

**How the site arrived makes no difference.** A site this browser holds is reseedable whether it came over WebRTC, from a GoFile mirror, or was deployed here in the first place, and the payload is looked for in all three places it can be: the page (captured during this load), the seeding store (a session record already *is* a payload — metainfo and ordered entries — so a paused site needs nothing else), and a `payloads` store in the cache database, which is what survives a session ending. A deployment writes that store as it goes live, so deleting a site's card in Pages stops this browser hosting it without losing the ability to put it back: **Delete website** takes it off the air, **Reseed** puts it back while a copy is still here, and **Delete data** is the one that leaves nothing. Only a site whose payload was never held — a partial download, a load with no `.torrent`, or one too large to keep a second copy of — says so on the button instead of offering a reseed that cannot work.

What "saved" means here is deliberately strict, because the promise is that the site is still there on the next load:

- A write settles on the transaction's `complete`, never on the request. A successful `put` is not a durable write — IndexedDB reports the request inside the transaction, which can still abort afterwards — so a deployment is not treated as saved until it has committed, and an abort surfaces as a failure instead of being lost
- A torrent enters the live registry only after that commit: the registry is exempt from every teardown path, so a torrent whose payload was never stored would be one nothing could stop
- Writes for the same info hash are serialized. A mirrored deploy records itself twice in quick succession, and both calls read before they write; chained per hash, the second reads what the first wrote and the newest metadata wins without re-copying the payload
- Restoring runs a few sessions at a time rather than one after another, so a session that never calls back cannot hold the rest of start-up behind its timeout — and a torrent that arrives after that timeout is destroyed rather than left running untracked
- An owned torrent is followed to the end of its life: when one errors or closes, it leaves the registry and its card says so, rather than reading "Seeding" because an object is still in a `Map`
- Stopping is broadcast to this browser's other WEB25 tabs over a `BroadcastChannel`. IndexedDB is shared but the live torrents are not, so without it a site the publisher stopped would go on being served from a tab they were not looking at. Nothing leaves the browser; a browser without `BroadcastChannel` simply catches up on its next reload

Signed-but-not-yet-deployed artifacts are still kept in `localStorage` (`web25.deploy.session.v1`) so the deploy screen survives a refresh mid-flow. That artifact belongs to whoever signed it, so it is restored **on sign-in, not on load**: it used to come back on every load and reveal the deploy panel outright, which — since the session dies with the page — meant a browser holding a bundle from the last half hour showed the deploy pipeline to somebody with no wallet unlocked.

Nothing signed-in-only is allowed to flash past while the wallet is being read, either. A page that has just loaded is always signed out, so the markup ships that way: the tab reads **🔐 Sign in** from first paint rather than being corrected by JavaScript a second later. What genuinely is unknown at that point — whether this browser holds a wallet at all, which decides between Unlock and Create — waits behind a placeholder instead of showing all three ways in and withdrawing one. And a page that comes back without being reloaded (a phone restoring a backgrounded tab from the back/forward cache) re-asks the worker who is signed in, because its DOM is describing a session that may be gone.

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
- for saved contacts Nostr is the messenger and WebRTC an upgrade: it is tried
  only while both sides have the same conversation open, preferred while its
  DataChannel is open, and dropped when either side closes the chat (see 8d);
  for a first contact the handshake still offers WebRTC first and the relay
  takes over if it cannot connect
- fallback messages keep the existing Web25 signed + ECIES envelope *and* add
  NIP-44 on top; relays are just another untrusted pipe
- Nostr private-key operations happen inside the wallet worker and fail when the
  wallet is locked; no `nsec` is ever produced or persisted

NIPs used: **NIP-01**, **NIP-19**, **NIP-44 v2**, **NIP-59**, **NIP-17**.
NIP-04 is not implemented. See `docs/nostr-direct-messenger.md`.

---

### 8a) The messenger layout, desktop and phone

The Chat tab is laid out like a desktop messenger: the chat list on the left,
the open conversation on the right, each scrolling on its own inside a window
that fits the screen, with the composer pinned to the bottom.

- **Chat list:** your Nostr address on one line with a **📋 Copy** button and
  the **New connection** button beside it, a contact filter, pending
  **invitations**, then your contacts — letter avatars (no profile picture is
  ever fetched), a presence dot and "online", an **unread count** for what
  arrived while their chat was closed, and Rename / Remove on each row
- **Nothing selected:** a quiet empty pane. The contacts and the conversation
  are the app; onboarding is not on the main screen
- **Conversation:** a header with the peer's avatar, name and the single
  connection state underneath it, plus **Save contact** and **Close**.
  Messages are bubbles with the time in the corner; a run from one side shares
  a tail, each day gets a chip, and service notices ("Peer verified …") are
  centred pills. The sender's address and full date are in each bubble's
  tooltip
- **Files are bubbles in the thread**, on the sender's side, with progress
  while they run, "Sent" when done, and a received file is tapped to save
- Reading back through history is not interrupted by new messages; a
  **jump-to-latest** button appears instead. Pressing Send keeps focus in the
  field, so a phone keyboard stays open

**Exchanging addresses** is the first thing anyone does, so it leads:

- **New connection** (the button next to Copy) opens the exchange in a sheet
  over the app — a dialog on desktop, a bottom sheet on a phone; Escape, the
  close button or a tap on the backdrop closes it, and it touches no open
  conversation. **① Your address** is shown whole, in groups that are easy to
  read out and compare by their two ends, with **Copy address** and, where the
  platform has a share sheet, **Share…** (a ready-to-forward message: the
  address and where to paste it). **② Start a new chat** takes theirs, and
  **③** says what happens next. A request that goes through closes the sheet and
  opens the conversation
- Pasting is the whole gesture: the npub is picked out of whatever arrived — a
  `nostr:` link, a forwarded sentence, an address broken across lines — and the
  search runs without pressing Search. A **Paste** button appears where the
  browser can read the clipboard, and a cut-off npub is flagged as you type
- The grouped address is separate elements with no whitespace between them, so
  even a hand selection copies as one unbroken address
- Tapping the peer in a conversation header shows **their** address and their
  verified EVM address in a native dialog, a bottom sheet on a phone. Each
  contact row can copy that contact's npub

**The first connection** is shown, not implied:

- Tapping a saved contact opens their conversation at once, working over
  Nostr — no request, no waiting. **Request chat** to somebody new opens the
  conversation straight away, with the steps in the thread: *Chat request* →
  *Both of you agree* → *Encrypted connection*. While waiting it says whether
  they look online, where the request lands for them (**Chat invitations**) and
  how long it stays valid, with **Cancel request** (the same path as Close)
- The composer stays closed until something can actually be sent, and its
  placeholder says why; a dropped link becomes a one-line banner over the thread
- **Accept** on an invitation answers at once and cannot be pressed twice

A phone cannot show both panes, so there the panel behaves like a phone
messenger — without a second code path: it is the same DOM, laid out
differently.

- **Opening a conversation takes the whole screen.** The **←** in its header
  brings the list back. That is navigation, not disconnection: the
  conversation stays open and connected behind it, a **Back to conversation**
  bar at the top of the list returns, and Close remains the only thing that
  ends a chat
- With no conversation open, the list is the whole screen

Both switches are phone-only furniture, and both pane rules are conditional on a
conversation actually being open, so desktop never sees any of it.

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
- **Decline** discards *that* invitation: no answer, no connection, no contact.
  The peer is not notified, because that would confirm the npub is live. It
  answers the invitation, not the person: a request they send later is shown
  again. The declined one is remembered — a request by its timestamp, an offer
  by its session — so a relay delivering it again on reconnect does not bring
  it back
- **Block** (on an invitation, a contact row, or the contact card in a
  conversation) answers the person: their requests and offers are dropped from
  then on before any intent is recorded, any invitation of theirs goes, a
  friendship ends, a conversation with them closes and history kept from it is
  deleted. They are not told. A block needs only the npub — a request carries
  nothing else — and is stored sealed to the wallet like the contacts, so it
  holds across sessions. **Blocked** under the contact list undoes it; an
  unblocked peer is a stranger again, not a friend
- a request ages on the **sender's** clock, taken from the timestamp inside the
  sealed rumor. The inbox deliberately looks days back on every start, so
  without that a week-old request would be presented as a decision to make now;
  a timestamp in the future is clamped, so nobody can mint an invitation that
  never expires
- **every request and invitation is acted on once, in one session.** Relays
  hand stored events back on every reconnect, every resubscription and every
  page load (the inbox asks for days of history). An inbox ledger
  (`web25-inbox`: truncated hashes and times only, kept just longer than any
  relay will replay) claims each gift wrap, and the request or invitation
  inside it, the first time it is seen; a repeat is dropped before any
  decryption, here or after a reload. An offer created before this page's inbox
  opened (with a few minutes' grace for clock skew or a reload mid-handshake)
  was made for an earlier session and is neither answered nor shown. Without
  this, an old request from a trusted contact made the browser send a fresh
  request and offer back on every reload, and an old offer was answered again
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

Trusted friends never ask again: their conversation simply opens (see 8d), and
a friend never lands in the invitation queue. A chat request from one — their
side has lost this browser's keys — is answered only while their conversation
is open here, and otherwise waits on their row. Every existing cryptographic
check still runs, plus one more: an invitation's identity tuple
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

The Friends list offers open, copy address, rename, remove and block (behind
**⋯** on a touch screen). Removing is a local authorization change only — the
peer is unknown again and their next invitation needs approval; **no key is
deleted or rotated** on either side.

**Saving a contact** needs the peer's verified identity tuple, which exists only
once the handshake has verified it. The conversation's **Save contact** button
is there from the moment a conversation opens, so pressed earlier it no longer
fails on a missing key: the name is taken and the save completes by itself
when the chat connects (the button reads *Saving…* until then, *Saved* after,
and renames from there on). Names, removals and blocks are asked in the app's
own dialog — `window.prompt`/`confirm` are suppressed by many in-app browsers,
and a suppressed prompt reads as Cancel, which is why Save contact used to do
nothing there.

**Keeping messages** is per conversation and off by default. The contact card
(tap the peer in the conversation header) offers *Off · 24 h · 3 days · 7
days*; while it is on, a 🕓 badge sits by the name and the thread says so.
Messages are stored in their own IndexedDB database (`web25-messages`), each
one sealed with NIP-44 v2 to the wallet's own key, next to an opaque
conversation tag (a hash of both public keys), its time and its expiry — no
text, no key, no address in the clear. Expiry is the message's own timestamp
plus the window, a peer's future-dated timestamp is clamped to now, and seven
days is a hard cap. Expired rows are deleted on start and every ten minutes;
that reads only the expiry, so it runs with the wallet locked too. Turning it
on keeps the session so far; turning it off deletes what was kept. Kept
messages come back above the live thread when the conversation reconnects.
Chat text only — files and service notices are not kept — and only on this
device: the other person decides for theirs.

**Held until read.** A message from a saved contact whose conversation is closed
is stored the same way — sealed, in the same database — and marked unread,
whatever the conversation's retention, because nobody has seen it yet. It stays
until the conversation is opened and it has been shown, and never past seven
days from its timestamp, read or not. Once shown it is released onto the
conversation's own terms: kept for its retention, or deleted at once if the
chat keeps nothing — and the thread says which, so holding it is never a silent
exception. The unread marks are plain flags beside the sealed rows, so the
badges come back after a reload without decrypting anything.

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

### 8d) Persistent rooms and Nostr-first contacts

A saved contact's conversation is not a session any more; it is a **room**,
named after the two people in it: both npubs, sorted, hashed
(`src/channels/ConversationRoom.js`). Each side derives it alone, the same pair
always gets the same room — after a reload, a reconnect, a week offline — and
every message carries it. The WebRTC `sessionId` is still a one-time handle
that binds an answer to its offer; it is never the room.

```text
tap a saved contact   →  their room opens, keys from the contact record
                          → Connected · Nostr, the composer works at once
                          → "conversation open" sent to them, gift-wrapped
their side open too?  →  one side (lower pubkey) offers a direct link
                          → Connected · WebRTC while the DataChannel is open
either side closes    →  "conversation closed" → link torn down
or switches              → the room carries on over Nostr
```

| Situation | Transport |
| --- | --- |
| Contact offline | Nostr — held for them, delivered when they are back |
| Contact online, chat closed | Nostr |
| Only you have it open | Nostr |
| Both have the same chat open | WebRTC is tried |
| WebRTC connected | WebRTC |
| WebRTC fails or drops | Nostr, without a gap |
| Either side closes or switches | WebRTC torn down, Nostr carries on |

A Nostr-only conversation is a working conversation, not a degraded one: it
shows **Connected · Nostr** in green.

Three signals are kept apart: **presence** (a public beacon — reachable at all),
a **chat request** (how a stranger asks), and **conversation open/closed** (a
private notice between saved contacts). Only the last one starts WebRTC, and
only when it is mutual and recent: whoever opens second hears back from the
first within a relay round trip. Being online, receiving a message, or a
contact's chat request never starts a handshake, and an offer from a contact
whose chat is closed here goes unanswered with no ICE gathered.

**Inbound routing.** The inbox stays subscribed while the wallet is unlocked and
Nostr is on, whichever conversation is open. Every NIP-17 rumor is handed on
with the sender the NIP-59 seal proved, and only then is it decided who may be
heard:

- the open conversation's peer → the thread;
- a saved contact whose chat is closed → the message is decrypted and its
  signature checked against **the keys in their contact record**; the room it
  names must be theirs; it is held unread and their row is badged;
- anybody else → dropped unread. A stranger still has to send an invitation; a
  stranger's "conversation open" is treated as exactly that — a chat request.

A room id is a name, not a credential: anybody can compute anyone's room, so a
claimed room never makes a sender trusted. A message signed by one contact for
another contact's room is dropped. Each message is handled once — by its gift
wrap and by its own id in the inbox ledger — so a relay replaying it, a
re-wrapped copy, or the same message seen live and delivered again later is
neither shown nor counted twice.

### 9) WebLLM — a local AI chat (Llama 3.2 1B on desktop, SmolLM2 360M on mobile)

A signed-in-only **WebLLM** tab runs `Llama-3.2-1B-Instruct-q4f32_1-MLC` on desktops
and laptops, and `SmolLM2-360M-Instruct-q4f32_1-MLC` on phones and tablets, entirely
in the browser with [MLC WebLLM](https://github.com/mlc-ai/web-llm) on WebGPU. No
inference server, no API key, and no link to Nostr, WebRTC, the wallet or the
Chat service.

- **Lazy by construction.** Start-up loads only `src/webllm/WebLLMTab.js`, a
  gate with no imports. Opening the tab (while signed in) imports the app,
  checks WebGPU and reads the cache state; the weights download only after
  **Install Llama 3.2 1B** (**Install SmolLM2 360M** on a phone). A later session finds the model cached and loads it
  straight into the chat.
- **Pinned library.** `@mlc-ai/web-llm@0.2.85` (`lib/index.js`) from jsDelivr,
  checked against a pinned SHA-384 before it runs, and imported from a blob URL.
- **Dedicated inference worker.** `src/webllm/webllm-worker.js` owns the engine
  (download, WebGPU, streaming chat completions). Where a browser has no WebGPU
  in workers, the same engine host runs on the page behind the same messages.
- **Dedicated service worker.** `webllm-sw.js` is registered on `/webllm/`, the
  first time the tab is opened, beside `peerweb-sw.js` (which keeps `/`). It has
  no `fetch` listener and controls no WEB25 page; requests go to its
  registration over `MessageChannel` ports. It keeps a verified copy of the
  library in `web25-webllm-assets-v1`, reports the model's state by reading
  WebLLM's own `webllm/model|config|wasm` caches (the weights are never
  copied), and deletes the model on request. It never runs inference.
- **One download per browser.** Install joins an install already running, and
  a Web Lock (`web25-webllm-install`) makes a second tab wait and then load
  from the cache. The storage quota is checked first and persistent storage
  requested.
- **Wallet lock.** Locking hides the tab, terminates the worker (freeing the
  GPU) and closes that wallet's saved conversations (a reply being written is
  saved as interrupted first). The model files stay cached for the next unlock.
  The chat has no control that removes the model: deleting conversations never
  touches the weights, and the browser's own site-data settings are the way to
  reclaim that space.

#### Model and generation settings — matched to the official WebLLM Chat

This section describes the desktop model; the mobile one is in the next section.
On desktop, WEB25 runs the same model with the same configuration as [chat.webllm.ai](https://chat.webllm.ai)
([source](https://github.com/mlc-ai/web-llm-chat)), whose defaults work on devices where
WEB25's first configuration did not.

- **Model:** `Llama-3.2-1B-Instruct-q4f32_1-MLC`, the official app's default, with the
  0.2.85 prebuilt record's files: weights from `huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f32_1-MLC`,
  `v0_2_84/base/Llama-3.2-1B-Instruct-q4f32_1_cs1k-webgpu.wasm`, 1128.82 MB VRAM, 4096-token
  context. 32-bit scales and activations, so no `shader-f16` and no reliance on a GPU's
  half-precision maths. WEB25 first shipped the **q4f16_1** build, and replies were reported
  incoherent and looping with it.
- **Sampling** (`WEBLLM_CHAT_OPTIONS`): temperature 0.6, top_p 0.9, presence and frequency
  penalty 0, context_window_size 4096 — the official app's `recommended_config` for this
  model. As there, they are passed to `engine.reload(modelId, chatOptions)`, where they
  replace those fields of the model's `mlc-chat-config.json`. Each request carries only the
  messages and `stream`/`stream_options`. Everything else is the model's own:
  `repetition_penalty` 1.0, the Llama 3 conversation template, and its stop tokens
  (128001 `<|end_of_text|>`, 128008 `<|eom_id|>`, 128009 `<|eot_id|>`).
- **System prompt.** Unlike the official app, WEB25 sends one short system message
  (`WEBLLM_SYSTEM_PROMPT`): a local web-development assistant for JavaScript, HTML, CSS,
  Web APIs and browser compatibility that also answers general questions, bases its answer
  on MDN documentation when some is included and says so, and otherwise answers from its
  own knowledge without claiming to have checked documentation or inventing sources.
- **No reply limit.** A reply ends at the end-of-turn token, or when the context window is
  full (`finish_reason: "length"`), where **Continue →** picks it up (see below).
- **History**, as the official app sends it: the last **4** messages before the new one
  (its `historyMessageCount`), under a token budget. The official app's `max_tokens: 4000` is
  that budget — it caps the estimated tokens of history sent and never limits a reply
  (`max_tokens` is not a chat-config field, so `reload()` ignores it). With no reply limit,
  WEB25's budget leaves the reply room in the same window: 3072 estimated tokens for the
  prompt, at least 1024 for the reply. One difference: only exchanges whose reply finished
  are passed back — a failed, stopped or loop-cut reply is not.
- **Inference path.** The official app uses `WebWorkerMLCEngine` with a
  `WebWorkerMLCEngineHandler`, which runs an `MLCEngine` in a worker. WEB25's inference
  worker runs the same `MLCEngine` from the same library behind its own small protocol; the
  tokenizer, prompt formatting, sampling, streaming and stop handling are all WebLLM's.
- **Loop guard** (`src/webllm/webllmLoopGuard.js`) stays as a secondary safety net only: it
  ends a reply whose sentences repeat as a cycle (3×), whose long sentence keeps recurring (6×),
  or whose text ends in a repeating stretch of characters. It ignores lists, short words,
  table rules and code, and relaxes when the user asks for repetition. The reply is cut back
  to its first occurrence and labelled.
- **The earlier q4f16 install.** Its files are different, so a browser that has it is shown
  the install screen for the new model. Nothing is downloaded until **Install** is pressed,
  and the old files are never deleted by the app.

To compare with the reference on a WebGPU device, select the same model on chat.webllm.ai
and try `hey`, `Hello, how are you?`, `What is JavaScript?`, `Explain WebRTC briefly.`, and a
short multi-turn exchange in both.

#### Mobile model, memory profile and batched streaming

Phones and tablets run a smaller model with a smaller memory profile; desktops keep exactly
the settings above. Both live in `WEBLLM_PROFILES` and `WEBLLM_MODELS`
(`src/webllm/webllmConfig.js`).

| Setting             | Desktop (unchanged)  | Mobile                           |
| ------------------- | -------------------- | -------------------------------- |
| Model               | Llama 3.2 1B q4f32_1 | SmolLM2 360M Instruct q4f32_1    |
| Download (approx.)  | ~800 MB              | ~250 MB                          |
| VRAM (0.2.85 record) | 1128.82 MB          | 579.61 MB                        |
| Conversation format | Llama 3 (`llama-3_1`) | ChatML (`<|im_start|>…<|im_end|>`) |
| Sampling            | 0.6 / 0.9 / 0 / 0    | 0.2 / 0.9 / 0 / 0 (SmolLM2's card) |
| Context window      | 4096                 | 2048 (set at engine `reload()`)  |
| Max reply tokens    | none (end of turn or full context) | 256 (`max_tokens` on every request) |
| Prompt budget       | 3072 estimated tokens | 1664 (2048 − 256 − 128 margin)  |
| KV cache (computed) | 256 MB               | 160 MB                           |
| Streaming render    | batched              | batched                          |

- **Which model.** The profile names it: `desktop` loads Llama, `mobile` loads SmolLM2. The
  page sends the model's key with `load`, and the inference worker accepts only keys from
  `WEBLLM_MODELS` (anything else is Llama). Install screen, chat header, status lines and
  error messages name the model in use; the system prompt names none. Auto, Short and
  Thinking all stay available on mobile — on Auto, SmolLM2 makes the choice.
- **A phone that held Llama.** SmolLM2 takes its place: when the tab is opened on a phone,
  every Llama 3.2 1B build in WebLLM's caches is deleted first (`replaces` in
  `WEBLLM_MODELS`, `clearReplacedModels` in the service-worker client), the install screen
  is SmolLM2's — its icon, size, credit and licence — and a line says Llama was removed to
  make room. The shared library cache stays. Nothing is downloaded until **Install**.
  Desktops and laptops replace nothing: Llama stays, and an older build is left alone.

- **Which profile.** Mobile when User-Agent Client Hints say so, the user agent names a phone
  or tablet (Android, iPhone, iPad, …), or a "Mac" has touch points (iPadOS). Decided once
  per page.
- **Memory.** WebLLM allocates the KV cache for the whole context window when the model
  loads. For Llama 3.2 1B (16 layers × 8 KV heads × 64 dims, keys and values, 32-bit in the
  q4f32 build) that is 64 KB per token; for SmolLM2 360M (32 layers × 5 KV heads × 64 dims)
  80 KB per token, so 160 MB at 2048 tokens. WebLLM's own records put SmolLM2 at about half
  Llama's VRAM. The KV figures are computed from the models' shapes, not measured on a
  device. The 256-token reply
  limit bounds how long one generation runs and keeps prompt + reply inside the smaller
  window. A reply that reaches it offers **Continue →**, which asks for up to 256 more
  tokens of the same reply.
- **Batched streaming (both profiles).** A streamed token only marks the reply as changed; it
  is drawn at most once per animation frame and no more than every 66 ms
  (`src/ui/webllm/streamBatcher.js`). Each draw redraws the reply's body once — so a code
  fence that has just opened or closed is drawn as a block — with one layout read and one
  scroll. Finishing, Stop, an error or New chat redraw from
  state, so the final text is always shown in full.
- **Dev-only switch.** On a development host (localhost, loopback, `.local`, private LAN
  addresses) `?webllm-profile=mobile` or `?webllm-profile=desktop` forces a profile, and
  the chat's status line says "mobile profile (dev)". Nothing is stored, nothing appears in
  the production UI, and web25.cloud ignores the parameter. Each reply logs its profile,
  token count, decode speed and finish reason to the console (`[WebLLM]`, debug level)
  for comparing profiles on a device.

Measured in headless Chromium (scripted 600-token stream, no model), from `main` to this change:

| Viewport                     | DOM mutations | Layouts   | Layout time      | Script time  |
| ---------------------------- | ------------- | --------- | ---------------- | ------------ |
| Desktop 1280×800             | 1851 → 69     | 621 → 66  | 737 → 57 ms      | 5 → 33 ms    |
| Phone 390×844, 4× CPU slowdown | 1851 → 75   | 621 → 73  | 2936 → 231 ms    | 22 → 110 ms  |

Not measured: response quality, generation speed, memory stability and long-reply crashes on
real phones (iPhone 15, Galaxy S22). None was available, and the model can't be downloaded in
the test environment.

#### Conversations, Continue and MDN documentation

- **Saved conversations.** Each conversation is kept in IndexedDB in this browser only — no
  server, sync or external database. The sidebar (a drawer on phones, behind the menu button)
  lists them by last activity, titled from the first question. **New chat** starts one (it is
  saved with its first message), a click opens one, and **Delete** removes only the open one,
  after a confirmation. Questions are saved when sent and replies when they finish; a reply cut
  short by Stop, an error, a wallet lock or a closed tab is saved with what was written and
  marked as interrupted, and is not sent back to the model as context.
- **Per wallet.** Every wallet has its own database, `web25-webllm-history-<id>`, where `<id>`
  is derived from a SHA-256 of the wallet address (the address itself is not in the name).
  Unlocking a wallet restores its conversations, most recent open; another wallet on the same
  browser sees none of them. This is separation, **not encryption**: anyone with access to the
  browser profile can read IndexedDB.
- **Retention.** Conversations are deleted after **7 days** without activity by default;
  **Settings** offers 1 day, 7 days, 30 days or **Until manually deleted**. The choice is stored
  in the same per-wallet database. Expired conversations are removed when the history is
  opened, whenever the list is read, and when the setting changes.
- **Continue →.** A reply that stopped at the length limit (256 tokens on mobile, the full
  context on desktop) shows an inline **Continue →** button. It resumes the same message — no
  new question, no repeat of what is there — by sending a text completion whose prompt is the
  conversation in Llama 3's own chat template ending inside that reply
  (`src/webllm/webllmPromptFormat.js`), with the same sampling, stop tokens and per-profile
  `max_tokens`. It is offered again if the continuation is cut off too, is disabled while
  anything is generating, and Stop works as usual. When the prompt plus the reply so far no
  longer fits the context, the button is replaced by a note to ask a follow-up or start a new
  chat. Only the latest reply can be continued.
- **MDN documentation.** For questions about web development, the chat looks things up on
  [MDN's MCP server](https://github.com/mdn/mcp) (`https://mcp.mdn.mozilla.net/`), directly
  from the browser over Streamable HTTP (`src/webllm/mdnMcpClient.js`) — MDN's server allows
  any origin, so there is no proxy. The lookup is deterministic, not chosen by the model
  (`src/webllm/mdnLookup.js`): `search` with a few keywords from the question, then `get-compat`
  for a compatibility question with a BCD key, otherwise `get-doc` for the top result, falling
  back to the search summary. The result is trimmed to a budget (900 estimated tokens on
  desktop, 420 on mobile, and never more than the prompt budget leaves), cleaned of template
  tokens, markup and links, and added to the system message as reference material, not
  instructions. The reply links its MDN pages (opened in a new tab, `noopener noreferrer`).
- **What is sent to MDN.** Only up to five keywords (60 characters) from the question — email
  addresses, URLs, hex strings and Nostr keys are removed first — then the page path or
  compatibility key MDN returned. Never the wallet, credentials, or the conversation. Requests
  carry `X-Moz-1st-Party-Data-Opt-Out: 1` (MDN's analytics opt-out), no cookies
  (`credentials: 'omit'`) and no referrer. **Settings → Look up MDN documentation** turns it off.
- **When MDN is unreachable** (offline, timeout after 8 s, an error), the model answers on its
  own and the reply says that MDN couldn't be reached, so the answer does not claim to be
  checked against documentation. Small talk and general questions never trigger a lookup.

Tested here with the official MDN MCP server code (`mdn/mcp`) run locally with fixture
responses for its upstream MDN and BCD requests, from headless Chromium on another origin;
the public endpoint and the model itself could not be reached from the test environment.

#### Reply modes, the sequence thinker, and GPU / CPU

- **Reply mode (Settings → How Llama answers).** **Short** is one answer in a small token
  window (360 tokens on desktop, 200 on mobile). **Thinking** writes a plan and then each step
  in its own request (up to 4 steps of 900 tokens on desktop, 3 of 256 on mobile), each step
  with its own MDN lookup. **Auto** (the default) lets Llama choose per message. Nothing is
  guessed from keywords: on Auto, Llama answers `{"mode": "short"|"thinking"}` and the plan is
  `{"steps": [...]}`, both constrained to a JSON schema with WebLLM's `response_format` and read
  with `JSON.parse` (`src/webllm/webllmThinking.js`). An answer that is not a valid decision is
  taken as Short; a plan with fewer than two steps means the task is written in one go.
- **The sequence thinker** (`src/webllm/webllmThoughtStore.js`) keeps each Thinking reply as a
  sequence of thoughts in IndexedDB, per wallet (`web25-webllm-thoughts-<id>`). It is modelled on
  [durable-thinking](https://github.com/linxule/durable-thinking)'s `ThoughtStore`: numbered
  thoughts with `totalThoughts` and `nextThoughtNeeded`, revisions (`isRevision`,
  `revisesThought`), branches (`branchId`, `branchFromThought`, branch-scoped numbers),
  idempotent appends by `clientRequestId`, and `{ ok, value | error: { code, message } }`
  results. The plan is thought 1 and each step the next one. Before a step is written it is
  given, within the profile's recall budget (900 tokens on desktop, 300 on mobile): **always the
  latest completed step** (with the larger share of the budget), then up to 4 (mobile: 2) more
  thoughts of the same conversation most like the step — this reply's or earlier answers', with
  only a small preference for this reply (`CURRENT_SEQUENCE_BONUS`, 0.05) so an older, more
  relevant thought still wins — above a similarity floor of 0.2, without duplicates, in the
  order they were thought. Thoughts go when their conversation is deleted or expires.
- **Steps that do not finish are not passed on as finished.** Each step's status comes from the
  generation's finish reason and deterministic checks of its text as the model wrote it — a code
  block left open, brackets / strings / comments left open in JS, CSS or JSON, `<script>`,
  `<style>`, `<body>`… left open in HTML; the fence closed afterwards for the screen does not
  count. A step cut at its token limit gets **one** continuation in place (450 tokens on
  desktop, 160 on mobile) when the context window still has room. A step that is still cut off,
  or ends with its code unfinished, keeps its text, gets a **⚠ Step N is incomplete** line and a
  notice under the reply, is stored with `incomplete: true` — never recalled as earlier work —
  and the next steps are told not to rely on it. A last step cut at the limit is left for
  **Continue** instead. Loop-guarded steps keep their first pass and count as done only if it
  holds together. No extra Llama request checks a step.
- **Recall by similarity, on the CPU.** Each thought is embedded in plain JavaScript by feature
  hashing (`src/webllm/thoughtEmbedding.js`: words, word pairs and three-letter pieces, 256
  dimensions, no model and no download) and indexed in
  [idb-vector](https://github.com/PaulKinlan/idb-vector) 0.2.0 (`web25-webllm-thought-vectors-<id>`).
  idb-vector is loaded from jsDelivr only after both of its files match their pinned SHA-384
  (`src/webllm/idbVectorLoader.js`). Without it, the same embedding is compared in the page.
  Indexing runs on a queue in the background and never holds up a step; each thought gets one
  vector, and every thought still without one (written while idb-vector was loading, or in a
  session where it never loaded) is backfilled as soon as it is there. Vectors of thoughts
  deleted while idb-vector is away are kept as tombstones and deleted when it is back; recall
  also drops stray vectors it meets. Version 2 of the database adds a `byConversation` index on
  thoughts, so recall reads one conversation rather than the whole wallet; version 1 databases
  are upgraded in place.
- **GPU for Llama only.** Llama runs on WebGPU and nothing else: every adapter request asks
  for `high-performance` without a fallback, a CPU-emulated (fallback) adapter is reported as
  unsupported instead of being used, and the inference worker is used only when it reports a
  real GPU (the choice is remembered with the chat settings). The thought store, the embedding
  and idb-vector never touch WebGPU — a test checks their code for it.
- **Code in replies.** Fenced blocks are drawn as code blocks with their language and a
  **Copy** button, and inline code, bold and headings are formatted
  (`src/ui/webllm/replyFormat.js`). Everything is built from text nodes: model output is never
  parsed as HTML.
- **Code as a project.** Each finished code block has a file-name field, **▶ Preview** and
  **Save to project**. A block that names its file — on the fence (```` ```html index.html ````),
  in a first-line comment (`<!-- index.html -->`, `// app.js`) or on the line just above it
  (`**style.css**:`) — is saved automatically when the reply ends. The conversation's files are a
  git repository in OPFS (see §10). Every commit in it — files saved from a reply, Project panel
  changes, removals — is authored by the signed-in user's Nostr address (npub; the wallet address
  if Nostr is off for it), never by the model, whose name is only shown in the chat. Deleting a
  conversation, or its expiry under the retention setting, removes its project too
  (`src/webllm/chatProject.js`).
- **A micro IDE around the chat** (`src/ui/webllm/WebLLMWorkbench.js`):
  - *Sidebar.* Two buttons at the start of the chat head pick its panel — **Conversations** or
    **Project** (with a file count). Pressing the open one again, or ×, closes the sidebar, on a
    desktop as on a phone (where it is a drawer).
  - *Project panel.* The files as a tree, folders first. **File** and **Folder** create in the
    selected folder; each row renames, deletes, goes **up a level** (arrow), or **moves to** any
    folder; rows can also be **dragged** onto a folder or onto the empty space for the top. All of
    it is a draft (`src/webllm/projectTree.js`), marked `A`/`M` per row, until **Save** commits it
    as one commit — or **Discard** drops it. **🚀 Deploy project** sits at its foot.
  - *Canvas.* A third column beside the chat (a sheet over it on narrower screens). **Preview**
    assembles the project's page — linked stylesheets and scripts inlined — and runs it in an
    iframe sandboxed without `allow-same-origin`, with its **console** listed underneath.
    **Code** is CodeMirror 6 (HTML, CSS, JavaScript) from `esm.sh`, every package pinned to one
    shared set of dependencies (`src/webllm/codeEditor.js`); without the CDN it is a plain editor
    that saves the same way. **Save** (or Ctrl/⌘+S) commits the file and writes it to the thought
    store, indexed by idb-vector, as the one current copy of that file: a Thinking reply recalls it
    with its other thoughts, and a Short reply is given the saved files most like the question.
    Moving a file moves that memory; deleting it forgets it.
---

### 10) OPFS workspace + isomorphic-git

The bytes Web25 keeps — sites it hosts, sites it has loaded, Llama's code — are files in the
**Origin Private File System**, and the ones that are projects are **git repositories**, through
[isomorphic-git](https://isomorphic-git.org/) imported from `esm.sh` (pinned,
`ISOMORPHIC_GIT_VERSION`) on first use, never at start-up. `src/storage/OpfsFs.js` is the
`fs.promises` isomorphic-git runs on, written directly against OPFS handles;
`src/storage/GitWorkspace.js` is the service on top of it.

```text
/web25/pages/<hash>/          git repo per site in Pages — the payload as it travels:
                              .torrentchain + site.bundle.json.gz (or the files, in files mode)
/web25/sites/<hash>/          unpacked files of a loaded, cached site — a plain tree
/web25/payloads/<hash>/       the payload kept so a cached site can be reseeded — a plain tree
/web25/chats/<wallet>/<id>/   git repo per Llama conversation — the code it wrote
```

- **Deploy** is unchanged — same in-memory bundle, same gzip + `.torrentchain`, same signature
  and seeding. Only where the result is kept changed: the seeding session's payload is written to
  `/web25/pages/<hash>` and committed (`Deploy <site> (<hash>)`), and the IndexedDB record keeps
  the ordered file list, types and sizes (`payloadStorage: 'opfs'`). The Pages card shows the
  repository and its commit.
- **Loading** over WebTorrent or a GoFile mirror caches the site's files under `/web25/sites` and
  its payload under `/web25/payloads` instead of inside IndexedDB rows. The render never waits on
  OPFS: the row is written as before, and its files are moved out of it right after. These are trees, not
  repositories: a loaded site becomes a repository only when it is **reseeded**, which puts it in
  Pages and commits it (`Reseed <site> (<hash>)`) like anything else there.
- **Migration** is automatic: seeding sessions stored inline move into their repositories on the
  next start, and a cached site moves to OPFS the next time it is read.
- **Fallbacks.** Without writable OPFS, for a payload with a path that cannot be a file of its
  own, or when a write fails, the bytes stay inline in IndexedDB exactly as before. Files are
  written before they are committed, and the commit runs in the background (with a timeout on the
  CDN), so an unreachable `esm.sh` costs the git history — never the data, a deployment or a reseed.
- **Safety.** Paths from torrents and from Llama are normalised and refused if they climb out
  (`..`) or touch a `.git` directory; a payload can never rewrite the repository that holds it.
  Each repository's writes are serialised (OPFS allows one writer per file).

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
├── storage/
│   ├── OpfsFs.js                    # fs.promises over OPFS, for isomorphic-git
│   └── GitWorkspace.js              # OPFS trees + git repos (pages, sites, payloads, chats)
├── channels/
│   ├── ChannelsService.js
│   ├── ConversationRoom.js
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
│   ├── about/
│   ├── auth/
│   ├── browse/
│   ├── pages/
│   ├── publish/
│   ├── channels/
│   └── webllm/WebLLMPanel.js
├── webllm/
│   ├── WebLLMTab.js                 # start-up gate (no imports)
│   ├── WebLLMApp.js                 # loaded when the tab is opened
│   ├── WebLLMController.js
│   ├── chatProject.js               # code blocks as files, per-conversation repo, Deploy project
│   ├── projectTree.js               # the Project panel's draft: moves, renames, folders → one Save
│   ├── canvasPreview.js             # the page the canvas previews, assets inlined, console bridge
│   ├── codeEditor.js                # CodeMirror 6 from esm.sh, textarea fallback
│   ├── WebLLMEngineClient.js
│   ├── WebLLMServiceWorkerClient.js
│   ├── webllm-worker.js             # dedicated inference worker
│   ├── webllmEngineHost.js
│   ├── webllmConfig.js
│   ├── webllmProgress.js
│   └── webgpuSupport.js
└── torrent/
    ├── RenderGate.js
    ├── SiteBundleCodec.js
    ├── TorrentChainProtocol.js
    ├── TorrentPublishService.js
    ├── TorrentSignaturePayload.js
    └── SignedTorrentProtocol.js

content/about/        # the six About "Deep dive" chapters, one Markdown file each
scripts/              # locally bundled libraries: DOMPurify, WebTorrent, marked
peerweb-sw.js         # app service worker, scope /
webllm-sw.js          # WebLLM service worker, scope /webllm/ (registered lazily)
```

### About page chapters (Markdown)

The six chapters under **About → Deep dive** are not in `index.html`. Each one is a Markdown file in
`content/about/` (`identity`, `publishing`, `messenger`, `consent`, `nostr`, `security`), and
`index.html` holds only six empty `<article class="about-card lp-reveal" id="about-…" data-about-src="…">`
frames plus the chapter index (`<a href="#about-…">`). `src/ui/about/AboutChapters.js` fetches the files,
renders them with the bundled [`marked`](https://github.com/markedjs/marked) (`scripts/marked.esm.js`, no CDN),
sanitizes the result with the bundled DOMPurify, and puts it straight into the article so the
`.about-card > h3 / > p / > .feature-grid` styles apply unchanged. A chapter that fails to load shows its
name, a link to its Markdown source and a *Try again* button, and the other five are unaffected.

Writing a chapter:

- `# Title` becomes the card's `<h3>` and `##` its `<h4>`.
- A feature grid is a `::: feature-grid` block holding a bullet list:

  ```md
  ::: feature-grid
  - 🔑 One feature, with `inline code` and **bold**
  - 🧊 Another
  :::
  ```

- Links to `http(s)` URLs open in a new tab with `rel="noopener noreferrer"`.
- Raw HTML is allowed but sanitized (HTML only; no scripts, forms, styles or event handlers).

To add a chapter, add the Markdown file, an article frame and an index link in `index.html` (the ids must
match: `about-<name>`). `tests/about-chapters-markdown.test.mjs` pins the six current chapters to
`tests/fixtures/about-chapters.legacy.html`, the markup they replaced; when you intentionally change a
chapter's wording, update the matching `<article>` in that fixture in the same commit.

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
- WebLLM (only after the WebLLM tab is opened): the library from `cdn.jsdelivr.net`, model weights from
  `huggingface.co/mlc-ai`, the compiled model library from `raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs`
- isomorphic-git (only when a deployment, a reseed or a chat project is committed): `esm.sh`
- CodeMirror 6 (only when the canvas first shows code): `esm.sh`
- MDN MCP server (only for web-development questions in the WebLLM chat, and only while enabled in its
  settings): `https://mcp.mdn.mozilla.net/` — receives a few search keywords, never wallet data

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
