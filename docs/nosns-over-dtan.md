# NosNS over DTAN (NIP-35 kind 2003)

This document describes the *public* Nostr use case in WEB25: publishing and
discovering websites. It is deliberately separate from
[`nostr-direct-messenger.md`](./nostr-direct-messenger.md), which covers the
private one.

```text
Direct Messenger  ->  private signalling + encrypted fallback (NIP-17/44/59)
NosNS             ->  public website discovery (NIP-35 kind 2003, via DTAN)
```

They share the relay client and the wallet-worker signing operation, and nothing
else. No SDP, ICE candidate, ECIES key or message content ever appears in a
NosNS event; a NosNS event is entirely public metadata.

## 0. What NosNS is

NosNS — the Nostr Name System — is a deliberately tiny convention on top of
standard DTAN torrent events. The whole protocol is four lines:

```text
  NIP-35 kind 2003
+ one official DTAN category chosen by the publisher
+ wss://relay.dtan.xyz as the only directory relay
+ a torrent name ending exactly in ".nosns.torrent"
```

There is **no custom event kind, no custom category and no required custom
tag**. The name suffix is the entire discriminator: a NIP-35 torrent whose title
ends in `.nosns.torrent` is a NosNS website, and one that does not is somebody
else's torrent. Keeping identification in the name rather than in a bespoke tag
is what lets NosNS entries live inside the real DTAN index instead of a private
corner of it.

The application remains a static frontend: the browser talks directly to STUN,
WebTorrent trackers and public Nostr relays. No backend, no relay proxy, no
server-side directory.

---

## 1. What the directory is, and is not

```text
DTAN / Nostr        -> tells users that a website exists
BitTorrent infohash -> identifies the distributed artifact
.torrentchain       -> proves the contents and the publisher
EVM signature       -> proves the WEB25 publisher identity
Nostr signature     -> proves who published the directory entry
```

Nostr is directory, discovery and search. It is **not** the source of truth for
authenticity or integrity. A NosNS entry that disagrees with the
`.torrentchain` actually downloaded is treated as untrusted, and the manifest
wins.

## 2. Where it sits in the deploy pipeline

The existing pipeline is unchanged; NosNS publication is appended to it.

```text
site files
    |
WEB25 deterministic bundle
    |
.torrentchain payload signed with the EVM identity   <- the one WEB25 signature
    |
site.bundle.json.gz
    |
BitTorrent torrent, info.name = "<site>.nosns.torrent"
    |
final infohash                                       <- exists only now
    |
seed via WebTorrent                                  <- deployment is complete here
    |
NIP-35 kind 2003 event, signed with the Nostr identity
    |
relay.dtan.xyz  (and nowhere else)
    |
the NosNS directory, inside the DTAN index
```

### Anti-circularity is preserved

`.torrentchain` is signed *before* the torrent is created, so the signed payload
cannot contain the final infohash - the infohash depends on the manifest, and a
manifest that depended on the infohash would be self-referential. The NosNS
event is built after the torrent exists, which is why it can safely carry both
the infohash and the mirrored proof. A test pins this.

### Only one EVM signature per website

The website was already signed when `.torrentchain` was generated. NosNS
publication mirrors that existing proof verbatim and never prompts for another
wallet signature — choosing a category does not change the signed payload and
does not ask for a second EVM signature. Tests count the signing calls.

## 3. The event

Kind `2003`, per NIP-35.

### The torrent name is the protocol

The `.nosns.torrent` suffix is the real BitTorrent `info.name`, applied when
WebTorrent creates the torrent — **not** a renamed download. `ensureNosnsTorrentName()`
is idempotent, so `my-site`, `my-site.torrent` and `my-site.nosns.torrent` all
normalize to `my-site.nosns.torrent` and re-applying it stacks nothing. The
downloadable `.torrent` file carries the same name.

NIP-35 says the title names the torrent, so the event's `title` tag is exactly
that name. The check is one line:

```js
title.endsWith('.nosns.torrent')
```

Matched **strictly**, in canonical lowercase: `Foo.NOSNS.TORRENT` is not a NosNS
name. Two accepted spellings would let one site be listed twice and make a
lookup by name depend on which spelling a client happened to use.
`ensureNosnsTorrentName()` is the single place that canonicalises, and what it
returns always passes the strict check.

The event title is the real `info.name` **verbatim** — never a display or site
name derived alongside it. NIP-35 says the title names the torrent, so a
separately derived name could drift from what the torrent actually says and
leave the entry unfindable by the name it is distributed under. A `siteName`
passed to the builder is treated as an assertion: if it disagrees with the
torrent name, publication fails rather than silently relabelling. A torrent
seeded without the suffix cannot be published at all, since inventing it in the
title would advertise a name the torrent does not have.

The UI strips the suffix for display; the raw title stays the protocol value.

### Choosing a real DTAN category

DTAN resolves `tcat` against a **fixed category tree** — `video`, `audio`,
`application`, `game`, `porn`, `other` (see `src/const.ts` in
[v0l/dtan](https://github.com/v0l/dtan)). An invented path matches nothing
there, so the original `tcat:web25.cloud,websites` produced entries that DTAN
accepted but never surfaced under any filter: published, and invisible.

NosNS publishes under a **real DTAN category chosen by the user**, defaulting to
`tcat:application` (a WEB25 site is a bundled web application). The taxonomy is
mirrored as frontend configuration in `src/nosns/NosNSProtocol.js` — a relay does
not expose a category list, DTAN defines it client-side — so the picker is
populated whether or not `relay.dtan.xyz` is reachable. Category loading and
relay connectivity are separate facts and are never reported as one.

```text
Applications            -> tcat:application
Applications / UNIX     -> tcat:application,unix
Other / Archives        -> tcat:other,archive
Other / E-Books         -> tcat:other,e-book
Video / Movies / 4k     -> tcat:video,movie,4k
```

The tags are compared against upstream path by path in
`tests/nosns-dtan-taxonomy.test.mjs`, because a mirror can drift and drift is
not cosmetic: a `tcat` DTAN does not recognise matches no filter, so the entry
is published and invisible. A one-character difference — `ebook` where upstream
says `e-book` — fails exactly like the old custom category while looking
perfectly reasonable in review. Display labels are deliberately local: the
picker nests options under their parent, so upstream's "4k Movies" inside a
"Movies" group would read as "Movies / 4k Movies".

**The category is chosen, never assumed.** There is no silent default at
publication: the picker opens on "— Select a DTAN category —", and deploying
without one skips publication rather than filing the site somewhere the
publisher did not pick and would not think to look. That skip never blocks the
deployment, and it is recoverable — choosing a category and pressing Retry
builds and publishes the entry.

The UI can only emit a value from that tree; an arbitrary category is refused
outright by both the event builder and the query filter, rather than quietly
rewritten. There is deliberately no `tcat:nosns`, no `web25:website` marker and
no `["t","nosns"]` hashtag — and the old `web25` / `website` / `static-site`
hashtags are gone.

```json
[
  ["title", "<site name>.nosns.torrent"],
  ["x", "<final BitTorrent infohash>"],
  ["i", "tcat:application"],

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

Discovery does **not** depend on these `web25-*` tags. An entry that carries the
suffix and nothing else is a NosNS website; it simply lists as `unverified`.

### The mirrored proof

`web25-message` is the exact string the wallet signed, copied byte for byte -
not re-serialised, since a re-derived payload could differ in key order and
would no longer verify. The individual `web25-*` tags are conveniences, and
`parseNosnsEvent()` rejects the event as `malformed` if any of them disagrees
with the signed message. That closes the gap where an entry could display one
publisher while proving another.

## 4. Relay configuration

The two purposes are kept separate, and in separate files:

| Constant | Where | Purpose |
| --- | --- | --- |
| `DEFAULT_NOSTR_DM_RELAYS` | `src/config/nostr.config.js` | private Direct Messenger traffic (unchanged) |
| `NOSNS_RELAYS` | `src/nosns/NosNSProtocol.js` | the directory — `wss://relay.dtan.xyz`, one entry |

The lists are **disjoint on purpose**: a public website listing is never
published into the pool that carries private DM traffic. The DM pool keeps its
redundancy across damus / nos.lol / nostr.band / snort; NosNS deliberately drops
that redundancy, because NosNS is a convention *inside* the real DTAN index and
scattering records across generic relays would put them outside the directory
people actually browse.

The trade-off is worth stating plainly: discovery depends on one relay being
reachable. It is only discovery — a site stays live, seeding and loadable by
infohash whatever the directory does, and a failed publish leaves a retry
available. The Deploy tab probes the relay early and reports it as
`NosNS Directory relay.dtan.xyz · Connected` or `· Unreachable`; an unreachable
relay never invalidates a deployment.

## 5. Publication, failure and retry

NosNS publication runs *after* the deployment is already complete, and its
result is reported separately:

```text
Deployment: Live / Seeding      NosNS: Published to 1 / 1 relays
Deployment: Live / Seeding      NosNS: Not published - Retry
```

A failure never rolls back or invalidates the deployment.

**Retries resubmit the exact same signed event** - same id, same `created_at`,
same title, same category, same tags, same signature. The category is frozen
once the event is signed. The event is built and signed once per artifact and
kept; retrying does not rebuild or re-sign it. This matters for DTAN, which can
be configured to enforce distinct infohashes: a rebuilt event would look like a
second torrent entry for the same site rather than a retry.

The signed event and the selected category are persisted with the existing
deploy session (public metadata only - no key material), so a retry still works
after a reload. The category is also kept in its own key, because it is chosen
*before* anything is signed and the deploy session only exists after signing.

## 6. Discovery

Browse has a DTAN category selector, and `NosNSService.buildNosnsFilter()`
queries one category at a time:

```json
{ "kinds": [2003], "#i": ["tcat:application"] }
```

The whole index is never requested by default. NosNS deliberately does **not**
depend on NIP-50 full-text search, which few relays implement; the flow is:

```text
select a DTAN category
    -> query relay.dtan.xyz for that category
    -> verify each event locally
    -> keep only titles ending in .nosns.torrent
    -> verify the mirrored WEB25 proof (entries without one stay listed)
    -> filter locally by text
```

Every event arriving from the pool has already been re-verified locally (shape,
id binding, BIP-340 signature) and re-matched against the requested filter; this
layer adds the structural validation, drops anything that is not a well-formed
NosNS entry, and merges the relays that carried the same entry so a duplicate is
rendered once. Results are cached per category, so switching back does not
re-query.

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
the directory entry. Whether the *website* publisher proof holds is the separate
EVM check, and only it can promote a result. A test pins exactly this.

## 8. Opening a site

The infohash stays the canonical locator. `Open` calls the existing
`loadSite(infohash)` - the same path as `?orc=<INFOHASH>` and the hash input.
There is no second website loading implementation, and the `.torrentchain`
render gate is unchanged and still authoritative:

```text
NosNS result -> infohash -> WebTorrent download -> read .torrentchain
    -> verify EVM signature -> verify bundle SHA -> render in sandbox
```

When a site is opened from a NosNS result, the claim travels with the
infohash and `verifyTorrentChainGate()` compares it against the manifest that
actually arrived (`matchesDownloadedManifest()`). Any disagreement is logged and
surfaced, and the directory claim is withdrawn — the downloaded manifest always
wins. The comparison never blocks a load that `.torrentchain` has already
verified on its own terms, and a site opened by hash carries no claim to check,
so the hash path is untouched.

## 9. Security

- NosNS reuses the existing wallet key. No new key, no second seed, no
  `nsec`, no generic private-key accessor.
- NosNS events are signed through the existing narrowly scoped
  `NOSTR_SIGN_EVENT` wallet-worker operation. The private key never reaches
  main-thread code.
- A locked wallet cannot create or sign a NosNS event.
- Every received event is verified locally; relays are untrusted throughout.
- The mirrored EVM proof is verified independently of the Nostr signature.
- Directory failure never weakens bundle verification or the render gate.

## 10. Modules

| File | Role |
| --- | --- |
| `src/nosns/NosNSProtocol.js` | the convention: relay, suffix, kind, DTAN taxonomy, naming helpers |
| `src/nosns/NosNSEvent.js` | pure NIP-35 event construction, parsing and proof verification |
| `src/nosns/NosNSService.js` | signing via the wallet worker, publication, retry, category queries |
| `src/ui/nosns/CategorySelect.js` | the hierarchical DTAN category pickers |
| `src/ui/publish/NosnsStatus.js` | Deploy-tab status, relay chip, category freeze |
| `src/ui/browse/NosnsPanel.js` | Browse-tab search, results and local filtering |
