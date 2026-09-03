# Nostr identity, signalling and relay fallback in the Direct Messenger

This document describes the Nostr layer added to Web25's Direct Messenger. It
complements `direct-message-torrentchain-bridge.md`, which describes the
WebTorrent transport; both share the same invitation envelope and validation
rules.

The application stays 100% frontend. There is no backend, no Node server, no
Cloudflare Worker, no signalling server, no Web25-operated relay, no relay proxy
and no database. The browser speaks directly to STUN, to WebTorrent trackers and
to public Nostr relays.

---

## 1. One key, three identities

The wallet holds exactly one secp256k1 private key, derived from the BIP-39
mnemonic at `m/44'/60'/0'/0/0` and sealed in the WebAuthn PRF vault. Nothing
about that changed. The Nostr identity is a third *view* of the same key:

```text
local wallet private key (in the dedicated wallet worker only)
   ├─ EVM identity     keccak256(pubkey[1:])[-20:]        → 0x…
   ├─ ECIES identity   uncompressed public key            → 04…
   └─ Nostr identity   x coordinate of the same point     → 64 hex chars → npub1…
```

Because the Nostr public key is literally `eciesPublicKey.slice(2, 66)`, an
invitation can be cross-checked in both directions: the key that signed the
NIP-59 seal must be the x coordinate of the ECIES key inside the payload.

No second seed, no second private key, and no `nsec` exists anywhere — the
codebase contains no `nsec` encoder at all, and a test asserts that.

## 2. Wallet worker boundary

The private key never leaves the dedicated wallet worker. Four narrowly scoped
operations were added to the fixed operation set in `walletWorkerProtocol.js`:

| Operation | Purpose | Returns |
| --- | --- | --- |
| `NOSTR_GET_PUBLIC_KEY` | the identity's x-only key and its `npub` | public material only |
| `NOSTR_SIGN_EVENT` | BIP-340 signature over a validated event template | `{ id, pubkey, sig, … }` |
| `NOSTR_NIP44_ENCRYPT` | NIP-44 v2 encryption to a peer key | base64 payload |
| `NOSTR_NIP44_DECRYPT` | NIP-44 v2 decryption from a peer key | plaintext |

Properties preserved:

- every one of them requires an unlocked, unexpired session;
- every payload is validated field by field before key material is touched;
- `NOSTR_SIGN_EVENT` is not a signing oracle: the worker computes the event id
  itself from a bounded `{kind, created_at, tags, content}` template, so a caller
  cannot obtain a signature over bytes of its own choosing;
- no operation returns the private key, and none was added that could;
- there is still no generic execute/eval command.

The NIP-59 *gift wrap* layer is signed with a throwaway key generated per
message on the main thread. That key is not the wallet key and is dropped
immediately, so no worker capability is needed for it.

## 3. Relay pool

`src/config/nostr.config.js` holds the single source of truth for the relay
list, and it holds exactly one relay:

```text
wss://nos.lol
```

Two browsers can only meet on a relay they both use. Spreading over several
relays looks more robust and behaves worse: a gift wrap accepted by one relay
and a subscription that is healthy on another simply never meet, and the
invitation is lost with nothing reporting a failure — every relay involved
answered `OK`. One relay makes the rendezvous deterministic, which is what a
first contact needs. `nos.lol` is a large, stable public relay that takes NIP-59
gift wraps without an allowlist.

The cost is stated plainly: while that relay is unreachable, the messenger is.
Nothing else in the app depends on it, and the list is one array — point it at
another relay, or at your own, and every client that shares that list can still
find every other.

`src/nostr/NostrRelayPool.js` opens plain browser WebSockets to the list and:

- tolerates unreachable relays — connections are attempted in parallel and
  failures are recorded rather than thrown;
- publishes to and subscribes across every connected relay;
- deduplicates by event id, so one gift wrap arriving twice is delivered once;
- re-verifies every inbound event locally (shape, `id` binding, BIP-340
  signature) and re-matches it against the filter that was actually requested;
- drops oversized frames, malformed frames, events for unknown subscriptions and
  events too far in the future;
- cleans up subscriptions and sockets on `close()`.

A relay is never treated as an authority for anything.

## 4. Direct Messenger flow

The panel has exactly two states: find someone, and talk to them. The manual
magnet exchange and the raw ECIES key display were removed from this panel in
favour of the address search.

```text
A types B's npub into the search box (or picks B from trusted contacts)
      ↓
address resolved locally; presence and profile looked up — neither connects
      ↓
A clicks "Request chat"  →  gift-wrapped chat request to B. No SDP yet.
      ↓
B's client verifies the gift wrap, then asks one more question:
"is A a trusted contact of mine?"
      ↓
 ┌────────────────┴─────────────────┐
 A is a trusted friend        A is unknown
      ↓                             ↓
 B consents automatically    B sees a pending invitation
 (crypto checks still run)   nothing sent · no ICE gathered
                                    ↓
                             B presses Accept
      ↓                             ↓
 └────────────────┬─────────────────┘
      ↓
B's own chat request goes back — intent is mutual, and only now
does either side create an SDP
      ↓
exactly one side offers (lower pubkey), in a NIP-59 gift wrap (kind
1059) carrying the Web25 invitation envelope
      ↓
the other answers it: identity tuple re-verified, contact stored
      ↓
both sides attempt the direct WebRTC connection
      ↓
 ┌────────────────┴────────────────┐
 DataChannel opens          no connection
      ↓                            ↓
 Connected · WebRTC         Connected · Nostr
```

### Cryptographic validity is not consent

This is the sentence the whole layer exists for. Verifying a gift wrap proves
the sender **is who they claim**. It does not establish that the local user
**wants to talk to them** — and anyone who knows an npub can produce a perfectly
valid offer addressed to it.

Answering is not free. It reveals:

```text
the local full ECIES public key   -> a long-term identity key
the local EVM address             -> the same identity, on-chain
ICE candidates                    -> this machine's network addresses,
                                     including local ones behind NAT
```

So an attacker who knew only a victim's npub could, in the old flow, send a
valid offer and have the victim's browser gather ICE and answer automatically —
learning their IP addresses without any interaction at all. That is the attack
this layer closes.

This applies to a chat request exactly as it applies to an offer. A request is
the only thing a stranger can send — an offer requires consent to have been
given already — so it is the request that appears in the pending-invitations
area, with Accept and Decline. Accepting is what sends consent back: B's own
chat request goes to A, the pair becomes mutual, and the handshake starts. Until
that button is pressed, B's browser has created nothing and sent nothing.

Declining discards the request and suppresses that peer for the session, so a
refusal cannot be worn down by repetition. The sender is told nothing either
way, because any reply would confirm the npub is live.

For a peer who is not an approved contact, `handleNostrInvitation()` does none
of the following: it does not call `createAnswerPayloadFromRemoteOffer()`, so no
`RTCPeerConnection` is created and **no ICE gathering happens**; it does not send
an answer; it writes nothing to the contacts store. The invitation is parked in
an in-memory queue and shown as a notification. The peer learns only that their
gift wrap was published, which they already knew.

The gate **fails closed**: when the contacts store cannot answer "is this a
friend?" — most importantly while the wallet is locked — the peer is treated as
unknown.

### Authorization on top of authentication

The contact layer never replaces a cryptographic check. Every existing
verification still runs, for trusted and untrusted peers alike: NIP-59 unwrap,
NIP-44 v2 decryption, Web25 bootstrap signature, recipient verification, TTL and
expiry, session id, nonce and replay protection, and local Nostr event
verification. Trust is one extra question asked *after* all of them.

A trusted contact is also re-checked against the invitation it sent:

```text
Nostr pubkey  ==  x coordinate of the ECIES key
EVM address   ==  keccak-derived from the same ECIES key
both          ==  what the stored contact record says
```

A matching contact record alone is never enough. If the tuple does not validate,
or disagrees with what was stored, the invitation is held for review like a
stranger's — so somebody who takes over an npub cannot inherit the trust
attached to it.

### Accept and Decline

**Accept** re-checks everything at the moment of the decision, because the
invitation has been sitting in a queue since it arrived: the TTL is re-checked
(a request that expired while the user thought about it is refused), and the
identity bindings are re-verified. Only then is the answer created and sent, and
only after that authenticated exchange is the peer persisted as a trusted
friend.

**Decline** discards the invitation and does exactly nothing else — no answer,
no connection, no contact record. The peer is not notified, because notifying
them would itself confirm that the npub is live and listening.

### Presence for an address you are looking up

Typing an `npub` into the search box temporarily subscribes to that address's
NIP-38 beacon, so the user can see whether a request is likely to be seen before
they send one. It is strictly read-only: no offer is created, no ICE is
gathered and nothing is sent to that peer — being online is not an invitation.

`watch()` replaces its whole subscription set rather than adding to it, so the
searched address and the contacts are combined in one place; layering them would
silently unsubscribe one or the other. The address is dropped again when the
search is cleared or a conversation is left.

Because a beacon has to arrive, there is a real third state. Immediately after
subscribing nothing has come back yet, and reporting that as "offline" would be
a guess presented as fact, so it shows as "checking" until either a beacon lands
or the grace window closes.

### Presence is not consent either

Presence and conversation are deliberately separate states:

```text
presence  ->  "reachable right now"   public, coarse, says nothing about who
intent    ->  "I want to talk to you" private, gift-wrapped, one peer
consent   ->  "I will answer you"     local, explicit, never inferred
```

Presence is a NIP-38 user status (kind 30315) under the `web25-dm` `d` tag, with
empty content — its existence and freshness are the whole signal, so it leaks no
status text. A beacon older than `PRESENCE_TTL_MS` is simply offline; nobody has
to announce leaving.

Selecting a contact sends a **chat request** (a gift-wrapped rumor of kind
`WEB25_CHAT_REQUEST_KIND`) and nothing else. It carries no SDP, no ICE and no
ECIES key.

Exactly one side offers, chosen by comparing the two Nostr public keys, because
both reach the connecting state at the same moment and two simultaneous offers
would leave nobody answering.

### Trusted contacts, and how they are protected

Contacts live in their own IndexedDB database, `web25-contacts`, and are
**encrypted at rest with the wallet's own Nostr identity** — NIP-44 v2 to self,
through the existing narrowly scoped wallet-worker operations. There is no
second password and no separate unlock path: the wallet/passkey protection the
app already has is the protection here too.

A decrypted record is:

```text
{ nostrPublicKey, npub, eciesPublicKey, evmAddress, name, trust,
  createdAt, updatedAt }
```

A stored row is not:

```text
{ id, ownerTag, ciphertext, createdAt, updatedAt }
```

`id` is `sha256(owner ‖ peer)` and `ownerTag` is `sha256(owner)`. Both are
derived from public keys, so they leak nothing an npub does not — but they keep
the *list itself* unreadable while locked: a row names neither party. Everything
else, including the display name and the trust state, is inside the ciphertext.

**No private key, PRF output, raw derived secret or equivalent is written here.**
The only things persisted are ciphertext and timestamps.

Consequences, all of them intended:

- while the wallet is locked, the contact list cannot be read at all — the UI
  says so rather than showing an empty list;
- locking clears the decrypted list from main-thread state and drops any pending
  invitations, so nothing survives in memory either;
- unlocking again restores access to exactly the same contacts.

Contacts saved before this layer existed are **migrated, not discarded**. A v1
record stored the Nostr key and the EVM address but not the ECIES key; the Nostr
key *is* the x coordinate of that peer's secp256k1 point, so there are exactly
two candidate points and the stored EVM address says which one is real. The
recovered key is verified against that address, so this is a recovery rather
than a guess. A v1 row that cannot be turned into a verifiable tuple — one saved
from a bare npub search, with no EVM address — is dropped rather than trusted.
Either way the plaintext row is deleted on the first unlocked operation.

The friendly name is the user's own label and is **never published** — attaching
a human name to a public key on a relay would deanonymise the contact for
everyone.

The Friends list offers **open**, **rename** and **remove**. Removing is purely
a local authorization change: the peer becomes unknown again, so their next
invitation waits for approval like any stranger's. **No wallet or Nostr key is
deleted or rotated** on either side.

### The address search

`normalizeNostrPublicKey()` resolves the typed value — an `npub1…` or a raw
64-character hex key — entirely locally; a malformed address is rejected before
anything touches the network. The profile lookup on top of it
(`NostrProfileLookup.js`) asks the pool for the most recent kind-0 event by that
author and shows a display name, so the user can confirm they have the right
person before starting a chat.

The lookup is a convenience, never a gate: no profile found still means a
perfectly messageable address. Everything it returns is attacker-controlled text
from a public relay, so each field is type-checked, stripped of control and bidi
characters, length-capped, and written to the DOM with `textContent`. The
profile `picture` is deliberately not returned — rendering a remote image would
make the browser fetch an arbitrary third-party host.

The one privacy cost is inherent to the protocol: the relays you are connected
to learn which pubkey you looked up.

### One connection status

The UI shows a single indicator, never two that could disagree:

```text
Waiting for them to accept…   intent sent, not yet mutual
Nostr handshake completed     mutual; invitation exchanged
Connecting via WebRTC…        negotiating the direct connection
Connected · WebRTC            green
Connected · Nostr             green
Disconnected
```

Both working states are green: once the conversation works, the transport is a
detail of that success, not a warning. `ChannelsService` derives this one state
from the transport, so no other component renders connection status.

WebRTC remains the preferred transport. The fallback is armed only when:

- the WebRTC connection deadline (25s) elapses with no open DataChannel, or
- the peer connection reports `failed`/`closed`, or
- it reports `disconnected` and stays that way past a 12s grace period —
  a transient `disconnected` never triggers a fallback on its own.

If the DataChannel later opens, the conversation returns to WebRTC immediately.

### Invitation envelopes

Two shapes share one validation path (`DirectMessageBootstrapCore.js`):

- `direct-message-bootstrap-v2` — the existing ECIES envelope, used whenever the
  sender knows the recipient's full uncompressed ECIES key. That is the case for
  every answer, and for the WebTorrent flow.
- `direct-message-bootstrap-sealed-v1` — used when the recipient is known only
  by `npub`. A Nostr address carries only the x coordinate, which is not enough
  to run ECIES against, so confidentiality for that one hop comes from the
  NIP-44/NIP-59 layer the envelope never leaves. Authenticity is unchanged: the
  payload carries a Web25 secp256k1 signature produced inside the wallet worker.

Both then run the same checks: sender/recipient binding, ECIES key ↔ EVM address
agreement, Nostr key ↔ ECIES key agreement, SDP/role agreement, envelope and
session TTLs, future-skew limits, `replyToSessionId` binding, and single-use
replay protection keyed on `from:to:sessionId:nonce`.

### What relays can see

Only the `#p` tag of a kind-1059 gift wrap, signed by a throwaway key. The SDP,
ICE candidates, EVM address, ECIES public key, session ids and the sender's own
Nostr identity are all inside the encrypted layers. There is no publicly readable
bootstrap payload.

## 5. Message encryption is unchanged

The Web25 message layer is untouched and transport-agnostic:

```text
logical DM message
      ↓  JSON.stringify
      ↓  secp256k1/SHA-256 signature (wallet worker)
      ↓  ECIES-secp256k1-HKDF-SHA256-AES-256-GCM to the peer's public key
Web25 wire ciphertext
      ↓
 ┌────────────────┴────────────────┐
 WebRTC DataChannel          NIP-17 kind-14 rumor
                             inside a NIP-59 gift wrap
```

On the relay path the ciphertext is therefore encrypted twice: the existing Web25
ECIES envelope, plus NIP-44. A relay sees neither the plaintext nor the Web25
ciphertext. Inbound messages take one code path (`handleEncryptedWire`) whatever
the transport, so decryption, signature verification and the "verified peer
identity required" rule apply identically. There is no plaintext downgrade.

Message ids are stable, so a message delivered over both WebRTC and Nostr — or
fanned out by several relays — is rendered exactly once.

## 6. NIPs used

- **NIP-01** — event structure, ids, BIP-340 signatures, `REQ`/`EVENT`/`CLOSE`
  relay protocol.
- **NIP-19** — `npub` encoding of the public key (bare entity only; no `nsec`).
- **NIP-44 v2** — ChaCha20 + HMAC-SHA256 with HKDF-derived conversation keys.
  Verified against the published reference vectors, including the invalid ones.
- **NIP-59** — seal (kind 13) and gift wrap (kind 1059) with randomised
  timestamps.
- **NIP-17** — kind 14 chat rumors for the relay fallback.

NIP-04 is not implemented and is not accepted.

## 7. Identity management

The Identity page shows all three addresses of the one wallet key side by side —
EVM address, ECIES public key, Nostr address and Nostr public key — each with its
own copy button. Wallet-wide controls (Lock, Delete Wallet, Add Passkey) stay
grouped with the wallet status; the Nostr section carries only its own actions.

**Add / Delete Nostr Identity** controls *reachability*, not a key. Because the
Nostr address is the x coordinate of the wallet key, there is nothing separate to
create or destroy:

- **Delete** stops the gift-wrapped inbox subscription, leaves any active
  conversation, hides the address, and disables the Direct Messenger search.
- **Add** derives it again and resubscribes. The `npub` is always the same one.

The choice is persisted per wallet address in `localStorage` as the single string
`on` or `off` (`NostrIdentityPreference.js`). No key material is stored — that
rule is unchanged — and blocked storage falls back to the default rather than
throwing. Deleting the wallet clears its preference too.

What this cannot do is make an already-published `npub` unknowable. Anyone who
recorded it still has it, and re-adding the identity produces the same address.
It removes you from the relays; it does not rotate your identity.

## 8. What did not change

- STUN and the WebRTC DataChannel are unchanged.
- The WebAuthn PRF vault, the worker isolation model and the 30-minute
  auto-lock are unchanged.
- File transfer stays on the DataChannel; chunked transfers are deliberately not
  offered over public relays.
- `DirectMessageTorrentBootstrap.js` — the WebTorrent + `.torrentchain` DM
  bootstrap — is unchanged and still fully tested. Only its UI in the Direct
  Messenger panel was removed; the module can be re-surfaced without touching the
  protocol.
