# WEB25 website registry over Nostr (NIP-35 / DTAN)

This document describes the *public* Nostr use case in WEB25: publishing and
discovering websites. It is deliberately separate from
[`nostr-direct-messenger.md`](./nostr-direct-messenger.md), which covers the
private one.

```text
Direct Messenger  ->  private signalling + encrypted fallback (NIP-17/44/59)
Registry          ->  public website discovery (NIP-35 kind 2003)
```

They share the relay client and the wallet-worker signing operation, and nothing
else. No SDP, ICE candidate, ECIES key or message content ever appears in a
registry event; a registry event is entirely public metadata.

The application remains a static frontend: the browser talks directly to STUN,
WebTorrent trackers and public Nostr relays. No backend, no relay proxy, no
server-side registry.

---

## 1. What the registry is, and is not

```text
DTAN / Nostr        -> tells users that a website exists
BitTorrent infohash -> identifies the distributed artifact
.torrentchain       -> proves the contents and the publisher
EVM signature       -> proves the WEB25 publisher identity
Nostr signature     -> proves who published the registry entry
```

Nostr is registry, discovery and search. It is **not** the source of truth for
authenticity or integrity. A registry entry that disagrees with the
`.torrentchain` actually downloaded is treated as untrusted, and the manifest
wins.

## 2. Where it sits in the deploy pipeline

The existing pipeline is unchanged; the registry is appended to it.

```text
site files
    |
WEB25 deterministic bundle
    |
.torrentchain payload signed with the EVM identity   <- the one WEB25 signature
    |
site.bundle.json.gz
    |
BitTorrent torrent  (.torrentchain + site.bundle.json.gz)
    |
final infohash                                       <- exists only now
    |
seed via WebTorrent                                  <- deployment is complete here
    |
NIP-35 kind 2003 event, signed with the Nostr identity
    |
relay.dtan.xyz + generic relays
    |
public WEB25 website registry
```

### Anti-circularity is preserved

`.torrentchain` is signed *before* the torrent is created, so the signed payload
cannot contain the final infohash - the infohash depends on the manifest, and a
manifest that depended on the infohash would be self-referential. The registry
event is built after the torrent exists, which is why it can safely carry both
the infohash and the mirrored proof. A test pins this.

### Only one EVM signature per website

The website was already signed when `.torrentchain` was generated. Registry
publication mirrors that existing proof verbatim and never prompts for another
wallet signature. Tests count the signing calls.

## 3. The event

Kind `2003`, per NIP-35. The category is exactly:

```text
tcat:web25.cloud,websites
```

```json
[
  ["title", "<site name>"],
  ["x", "<final BitTorrent infohash>"],
  ["i", "tcat:web25.cloud,websites"],

  ["t", "web25"], ["t", "website"], ["t", "static-site"],

  ["file", ".torrentchain", "<size>"],
  ["file", "site.bundle.json.gz", "<size>"],
  ["tracker", "wss://tracker.openwebtorrent.com/"],

  ["web25-schema", "web25-torrentchain-v1"],
  ["web25-publisher", "0x..."],
  ["web25-chain-id", "1"],
  ["web25-created-at", "<ISO timestamp>"],
  ["web25-merkle-root", "<sha256>"],
  ["web25-bundle-sha256", "<sha256>"],
  ["web25-bundle-name", "site.bundle.json.gz"],
  ["web25-signature", "0x..."],
  ["web25-message", "<the exact signed message>"]
]
```

### File tags describe the real torrent

`describeTorrentArtifact()` reads the entries off the seeded torrent rather than
guessing from `SITE_BUNDLE_MODE`. In the default gzip mode that is
`.torrentchain` + `site.bundle.json.gz`; the site own files live *inside* the
compressed bundle and are deliberately not advertised as torrent entries. In
`files` mode the real per-file layout is advertised instead. Both are tested.

Trackers likewise come from the torrent own announce list, falling back to the
deployment configured trackers - the registry module holds no tracker
configuration of its own.

### The mirrored proof

`web25-message` is the exact string the wallet signed, copied byte for byte -
not re-serialised, since a re-derived payload could differ in key order and
would no longer verify. The individual `web25-*` tags are conveniences, and
`parseRegistryEvent()` rejects the event as `malformed` if any of them disagrees
with the signed message. That closes the gap where an entry could display one
publisher while proving another.

## 4. Relay configuration

`src/config/nostr.config.js` keeps the two purposes separate:

| Constant | Purpose |
| --- | --- |
| `DEFAULT_NOSTR_DM_RELAYS` | private Direct Messenger traffic |
| `DEFAULT_NOSTR_REGISTRY_RELAYS` | public registry - `wss://relay.dtan.xyz` first, then the generic relays for redundancy |

No single relay is authoritative. A DTAN outage cannot fail a deployment, and
cannot make an already-published site undiscoverable.

## 5. Publication, failure and retry

Registry publication runs *after* the deployment is already complete, and its
result is reported separately:

```text
Deployment: Live / Seeding      Registry: Published to 3 / 4 relays
Deployment: Live / Seeding      Registry: Not published - Retry
```

A failure never rolls back or invalidates the deployment.

**Retries resubmit the exact same signed event** - same id, same `created_at`,
same tags, same signature. The event is built and signed once per artifact and
kept; retrying does not rebuild or re-sign it. This matters for DTAN, which can
be configured to enforce distinct infohashes: a rebuilt event would look like a
second torrent entry for the same site rather than a retry.

The signed event is persisted with the existing deploy session (public metadata
only - no key material), so a retry still works after a reload.

## 6. Discovery

`Web25RegistryService.buildRegistryFilter()` queries `kind: 2003` with
`#i = ["tcat:web25.cloud,websites"]` and nothing else. Every event arriving from
the pool has already been re-verified locally (shape, id binding, BIP-340
signature) and re-matched against the requested filter; this layer adds the
WEB25 structural validation, drops anything that is not a well-formed website
entry, and merges the relays that carried the same entry so a duplicate is
rendered once.

Search filters the fetched results on site name, infohash, EVM publisher address
or npub / Nostr pubkey.

## 7. Verification states

A result carries `web25VerificationState`:

| State | Meaning |
| --- | --- |
| `verified` | the mirrored EVM signature recovers to the claimed publisher |
| `invalid` | WEB25 metadata is well-formed but the signature does not hold |
| `malformed` | WEB25 metadata is structurally broken or self-inconsistent |
| `unverified` | no WEB25 proof to check |

**A valid Nostr signature never implies `verified`.** The pool guarantees the
Nostr signature before an event reaches the service; that only says who wrote
the registry entry. Whether the *website* publisher proof holds is the separate
EVM check, and only it can promote a result. A test pins exactly this.

## 8. Opening a site

The infohash stays the canonical locator. `Open` calls the existing
`loadSite(infohash)` - the same path as `?orc=<INFOHASH>` and the hash input.
There is no second website loading implementation, and the `.torrentchain`
render gate is unchanged and still authoritative:

```text
registry result -> infohash -> WebTorrent download -> read .torrentchain
    -> verify EVM signature -> verify bundle SHA -> render in sandbox
```

When a site is opened from a registry result, the claim travels with the
infohash and `verifyTorrentChainGate()` compares it against the manifest that
actually arrived (`matchesDownloadedManifest()`). Any disagreement is logged and
surfaced, and the registry claim is withdrawn — the downloaded manifest always
wins. The comparison never blocks a load that `.torrentchain` has already
verified on its own terms, and a site opened by hash carries no claim to check,
so the hash path is untouched.

## 9. Security

- The registry reuses the existing wallet key. No new key, no second seed, no
  `nsec`, no generic private-key accessor.
- Registry events are signed through the existing narrowly scoped
  `NOSTR_SIGN_EVENT` wallet-worker operation. The private key never reaches
  main-thread code.
- A locked wallet cannot create or sign a registry event.
- Every received event is verified locally; relays are untrusted throughout.
- The mirrored EVM proof is verified independently of the Nostr signature.
- Registry failure never weakens bundle verification or the render gate.
