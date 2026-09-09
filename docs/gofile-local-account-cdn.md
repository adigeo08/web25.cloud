# GoFile local account and CDN-like mirror architecture

This document describes the **current WEB25.cloud GoFile design**.

GoFile is not the source of truth for a WEB25 site and it is not treated as
durable storage. It is an **ephemeral HTTP acceleration layer** used after the
local browser cache and before WebTorrent/P2P when a WEB25 address carries a
GoFile mirror locator.

The design goal is simple:

```text
fastest / cheapest path first

local cache
    ↓ miss
GoFile ephemeral mirror
    ↓ absent / unavailable / invalid
WebTorrent / P2P
```

The torrent hash and the normal WEB25 verification path remain the trust anchor.
GoFile only changes **how bytes arrive**, never what bytes are accepted.

---

## 1. Resolution order

The preferred load order is:

1. **Local WEB25 cache**
2. **GoFile mirror**, only when the WEB25 URL contains a mirror locator
3. **WebTorrent / P2P**

This is implemented by `src/core/torrent/PreferredSiteLoader.js`.

### Why this order

**Cache first** requires no network and is therefore the fastest possible path.

**GoFile second** acts as a CDN-like HTTP accelerator. When a deployment has a
working mirror, a new visitor does not need to wait for peer discovery before
receiving the site bytes.

**WebTorrent third** remains the decentralized fallback and the long-term
transport model. A missing or expired GoFile mirror must never make a valid
WEB25 deployment unavailable while peers still serve it.

The important distinction is:

```text
GoFile = acceleration / availability hint
Torrent = identity of the deployment + integrity boundary
```

A WEB25 URL may therefore carry both the torrent hash and the GoFile locator.
The locator is optional. If it is missing, loading naturally skips directly from
cache to P2P.

---

## 2. GoFile is CDN-like, not authoritative

WEB25 uses GoFile similarly to a temporary CDN origin:

- one HTTP-accessible copy can serve a deployment quickly;
- the copy is used before peer discovery;
- failure is transparent because P2P remains available;
- clients still verify the downloaded bytes locally.

It is deliberately **not** treated like a conventional authoritative CDN:

- WEB25 does not assume the mirror will remain available;
- WEB25 does not trust GoFile metadata as site identity;
- WEB25 does not allow the mirror to replace torrent verification;
- WEB25 does not depend on a paid or permanent GoFile account;
- losing the mirror does not invalidate the WEB25 deployment.

For product language, **"ephemeral CDN-like mirror"** or **"HTTP acceleration
mirror"** is more accurate than calling GoFile the hosting layer.

---

## 3. Local guest account lifecycle

Each unlocked WEB25 identity may hold one local GoFile **guest** credential.

The credential is best-effort and is provisioned only to support the optional
mirror transport. Failure to create or read it must not block wallet unlock,
signing, deployment, cache loading or P2P.

### Provisioning

When the local wallet becomes unlocked, WEB25 calls
`ensureGoFileCredential()`.

The flow is:

```text
wallet unlocked
    ↓
read encrypted GoFile credential for this identity
    ↓
credential exists ───────────────→ reuse it
    ↓ no credential
POST https://api.gofile.io/accounts
    ↓
receive guest token
    ↓
encrypt token to the local identity
    ↓
store ciphertext in IndexedDB
```

WEB25 does not replace an existing valid credential merely because another
account could be created.

If GoFile explicitly refuses the stored token as invalid, WEB25 clears that
credential and may obtain a new guest credential.

---

## 4. How the guest token is protected locally

The GoFile token is **not stored in plaintext** and it is not embedded in the
application source.

It is also important to describe the WebAuthn relationship precisely: the
GoFile token is **not encrypted directly with the raw WebAuthn PRF output**.
Instead, it inherits the existing WEB25 wallet security boundary.

The chain is:

```text
WebAuthn authenticator
    ↓ PRF output after user verification
HKDF-SHA256
    ↓
non-extractable KEK
    ↓ unwraps
wallet vault key
    ↓ decrypts
local wallet private-key blob
    ↓ transferred to dedicated wallet worker
secp256k1 identity
    ↓ wallet-worker Nostr operation
NIP-44 encrypt-to-self
    ↓
GoFile guest-token ciphertext
    ↓
IndexedDB: web25-gofile-credentials
```

The PRF output itself is never persisted.

The decrypted private key is not exposed through a getter. It is transferred to
WEB25's dedicated wallet worker, and callers request constrained cryptographic
operations instead.

`GoFileCredentialStore` uses the wallet's Nostr identity as the owner namespace
and stores only an encrypted record in IndexedDB:

```text
DB:    web25-gofile-credentials
Store: encrypted_credentials
Key:   gofile-credential:<nostr-pubkey>
Value: { id, ciphertext, updatedAt }
```

The plaintext token is recovered only through the wallet-backed Nostr decrypt
operation. Consequently:

- a locked wallet cannot read the persisted token;
- another local WEB25 identity cannot transparently read it;
- the token is not written to `localStorage`;
- the token must not be logged, placed in URLs, committed, or rendered in UI.

This is still client-side custody of a bearer credential. A GoFile token grants
account-level authority to whoever obtains it, which is why WEB25 intentionally
uses **disposable guest accounts**, not a valuable Premium account.

---

## 5. Uploading a mirror

A GoFile mirror is optional per deployment, but the deploy UI **preselects the
mirror option by default** so a normal deployment gets the HTTP acceleration
path without requiring an extra click. The publisher can uncheck the option
before deploying.

This is a UX default only. GoFile remains optional at the protocol level:
mirror creation failure does not fail the deployment, and a publisher who
explicitly opts out still gets the normal WebTorrent/P2P deployment.

When requested, WEB25 packages the exact deployment into
`web25-gofile-mirror-v1` and uploads it using a deterministic filename:

```text
web25-gofile-mirror-<torrent-info-hash>.json
```

The mirror contains:

- exact torrent metainfo;
- the payload files and paths;
- their bytes encoded for transport.

### One deployment, one fresh upload

WEB25 deliberately does **not** reuse a GoFile upload folder across
deployments.

Every mirror is uploaded independently. This avoids turning one public locator
into an index of a publisher's deployment history and prevents later uploads
from becoming ambiguous with earlier ones.

The stored guest credential is used when available. If an upload is performed
without one and GoFile returns a guest token, WEB25 can persist that new guest
credential through the encrypted local credential store.

A mirror locator is published only as transport metadata associated with that
specific deployment.

---

## 6. Why every mirror is ephemeral

GoFile storage is treated as **best effort**.

WEB25 makes no durability promise for guest uploads. A mirror may disappear
because of GoFile retention rules, account expiry, removal, service changes or
other external conditions.

Therefore:

```text
mirror exists       → use it for fast HTTP loading
mirror disappeared  → fall back to WebTorrent
```

No WEB25 identity or deployment should depend on the lifetime of a GoFile guest
account.

The mirror is intentionally disposable because:

- the guest account itself is disposable;
- the mirror is not the signed source of truth;
- the torrent/P2P network can continue without it;
- a replacement HTTP transport can be introduced later without changing site
  identity.

---

## 7. Reading a mirror

After a local cache miss, `PreferredSiteLoader` checks whether the WEB25 address
contains a GoFile locator.

If a locator exists, WEB25 tries the mirror **before starting the normal P2P
load**.

### Reader credential

GoFile's web download path requires a guest session even for this public mirror
flow.

WEB25 therefore obtains a reader credential as follows:

1. if the local wallet is unlocked and its encrypted GoFile credential can be
   read, reuse it;
2. otherwise create a throwaway guest account for the read;
3. a throwaway reader credential is not persisted merely to load another
   publisher's public mirror.

This means browsing a mirrored site does not require a user to have previously
deployed anything.

---

## 8. The WEB25 GoFile Worker

Browser-side GoFile reads are mediated by WEB25's Cloudflare Worker because the
underlying GoFile web/storage flow cannot be consumed reliably from browser
JavaScript directly due to CORS/session requirements.

Current Worker:

```text
https://gofile-cf-downloader.carlgray.workers.dev
```

The Worker is a **transport adapter**, not a credential authority.

It stores no shared WEB25 GoFile account. Each client sends its own temporary or
locally-held guest bearer for the request.

Conceptually:

```text
WEB25 browser
    │ Authorization: Bearer <guest token>
    ↓
WEB25 GoFile Worker
    │ resolves GoFile session/download path
    ↓
GoFile
    │ bytes
    ↓
WEB25 browser
    ↓
local cryptographic verification
```

The Worker can necessarily observe the bearer and the request while processing
it. That is part of the trust boundary of this optional acceleration transport.
The mitigation is to use disposable guest credentials and to keep GoFile
replaceable rather than making it a source of truth.

---

## 9. Mirror verification before render

GoFile bytes are never rendered merely because the HTTP request succeeded.

`GoFileMirrorCodec.verifyGoFileMirror()` verifies the mirror against the
requested deployment:

1. decode the `web25-gofile-mirror-v1` envelope;
2. bdecode the included torrent metainfo;
3. recompute the BitTorrent v1 info hash;
4. require it to equal the requested torrent hash;
5. require all expected torrent files to exist with exact lengths;
6. reject files that are not present in torrent metadata;
7. recompute and verify every BitTorrent v1 SHA-1 piece;
8. pass the verified payload through the same WEB25 render/signature gates used
   by the normal torrent loader.

Therefore a compromised or incorrect HTTP mirror should be able to affect
**availability**, but not silently substitute a different site that passes the
client's normal verification.

The security model is intentionally:

```text
untrusted transport
        +
client-side content verification
        =
replaceable acceleration layer
```

---

## 10. Failure behavior

A GoFile failure must not become a site failure while the torrent remains
available.

Examples that cause WEB25 to abandon the mirror and continue with P2P include:

- no locator in the WEB25 address;
- expired/deleted guest mirror;
- rejected or unavailable credential;
- GoFile timeout/network failure;
- Worker refusal;
- file not found;
- untrusted redirect/download page response;
- size mismatch;
- malformed mirror JSON;
- info-hash mismatch;
- file/path mismatch;
- BitTorrent piece verification failure;
- downstream WEB25 signature/render-gate failure.

The runtime order remains:

```text
CACHE HIT
   └─ render

CACHE MISS
   └─ GoFile locator exists?
        ├─ yes → fetch + verify
        │          ├─ valid   → render + cache
        │          └─ failed  → P2P
        └─ no  → P2P
```

A successful GoFile load is cached normally, so subsequent loads can become
local-cache hits and avoid both GoFile and P2P.

---

## 11. Privacy and security invariants

The implementation should continue to preserve these invariants:

1. **Never publish a GoFile bearer token.**
2. **Never place the token in a WEB25 URL.** The URL carries only the mirror
   locator.
3. **Never persist the token as plaintext.** Persist only wallet-encrypted
   ciphertext.
4. **Never reuse one public folder as the publisher's permanent deployment
   directory.** Each deployment gets a fresh mirror upload.
5. **Never trust GoFile bytes without torrent verification.**
6. **Never make GoFile availability mandatory for a valid deployment.**
7. **Never treat a guest mirror as durable storage.**
8. **Never replace a valid stored account merely because another guest account
   can be minted.**
9. **Clear a stored credential only when it is explicitly known to be invalid,
   not on ordinary transport errors.**
10. **Keep the Worker credential-less at rest.** Credentials arrive per request.

---

## 12. What GoFile is and is not in WEB25

| Property | GoFile mirror in WEB25 |
| --- | --- |
| Fast HTTP delivery | Yes |
| Preselected by default for new deploys | Yes; user can uncheck it |
| Used immediately after local cache | Yes |
| Used before P2P when locator exists | Yes |
| Durable source of truth | No |
| Required for a deployment | No |
| Trusted to define site identity | No |
| Client verifies torrent info hash/pieces | Yes |
| Guest account credential persisted plaintext | No |
| Credential protected by local wallet identity | Yes |
| Mirror expected to be permanent | No |
| Replaceable transport | Yes |

The intended product model is:

> **Cache for instant repeat loads, GoFile for opportunistic HTTP speed, and
> WebTorrent for resilient peer-to-peer availability — with verification at the
> client boundary regardless of transport.**
