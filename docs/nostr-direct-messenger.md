# Nostr identity, signalling and relay fallback in the Direct Messenger

This document describes the Nostr layer added to Web25's Direct Messenger. It
complements `direct-message-torrentchain-bridge.md`, which describes the
WebTorrent transport; both share the same invitation envelope and validation
rules.

The application stays 100% frontend. There is no backend, no Node server, no
Cloudflare Worker, no signalling server, no Web25-operated relay, no relay proxy
and no database. The browser speaks directly to STUN, to WebTorrent trackers and
to public Nostr relays.

> This document covers the **private** Nostr use case. The public one — the
> WEB25 website registry over NIP-35 — lives in
> [`web25-nostr-registry.md`](./web25-nostr-registry.md). The two share the
> relay client and the wallet-worker signing operation and nothing else: no
> SDP, ICE candidate, ECIES key or message content ever appears in a public
> registry event.

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
list:

```text
wss://relay.damus.io
wss://nos.lol
wss://relay.nostr.band
wss://relay.snort.social
```

`src/nostr/NostrRelayPool.js` opens plain browser WebSockets to all of them and:

- tolerates unreachable relays — connections are attempted in parallel, failures
  are recorded, and one working relay is enough;
- publishes to and subscribes across every connected relay;
- deduplicates by event id, so one gift wrap arriving from four relays is
  delivered once;
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
A types B's npub into the search box
      ↓
address resolved locally; the pool is asked for a kind-0 profile (optional)
      ↓
A clicks "Start chat"
      ↓
NIP-59 gift wrap (kind 1059) published to the relay pool
      ↓  rumor: Web25 invitation envelope with the WebRTC offer
B's inbox subscription (#p = B) receives, unwraps and validates it
      ↓
B answers with a gift-wrapped invitation carrying the WebRTC answer
      ↓
both sides attempt the direct WebRTC connection
      ↓
 ┌────────────────┴────────────────┐
 DataChannel opens          no connection
      ↓                            ↓
 P2P · WebRTC              Relay fallback · Nostr
```

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
