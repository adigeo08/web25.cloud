# Persistent project rooms (schema 1)

Deploy has an optional **Project subscriptions** selector. Choose **Create new
subscribable project** once, then explicitly select that project on subsequent
folder deployments. Folder names or file similarity never choose an identity.
The selector shows the persisted room and last successful version. A normal
deployment does not request a Nostr identity.

The viewer offers Subscribe only after verifying the `.torrentchain` EVM
signature and Nostr ownership proof. Unlock a Nostr-enabled wallet to subscribe.
Project conversations appear separately from trusted contacts in Nostr chat.
They contain version/date, an Open deployment link (`?orc=<infohash>`), and
optional magnet/mirror links. Unsubscribe and retry controls are in that
conversation. Publishers can inspect/remove subscribers and retry failed
notifications there. Relay acceptance is reported separately from recipient
receipt; the latter is not asserted.

## Public identity and signatures

`payload.project` is optional; manifests without it keep the legacy behavior:

```
{
  id: <32 random bytes, lowercase hex>,
  roomId: "prj-" + first32hex(SHA256("web25-project-room:v1:" + id + ":" + ownerNostrPubkey)),
  ownerNostrPubkey: <x-only public key, lowercase hex>,
  version: <positive safe integer>,
  previousManifestHash: <SHA256 of JSON.stringify(previous manifest), or null>,
  ownershipProof: <signed NIP-01 event>
}
```

Room names are 36 characters; the `room-` direct-conversation algorithm is
unchanged. Neither infohash, mirror, timestamp nor file contents determine the
project identity. `previousManifestHash` is null exactly for version 1.

The ownership proof has kind **24136**, empty tags, and JSON content with keys
in this order: `domain` (`web25-project-ownership:v1`), `projectId`, `roomId`,
`publisher` (lowercase EVM address), `ownerNostrPubkey`, `version`,
`previousManifestHash`. Its NIP-01 id and BIP-340 signature must verify against
the declared Nostr owner. The proof is constructed first and included in the
existing EVM-signed payload. Verification also requires the signed message to
match `JSON.stringify(payload)` exactly. An EVM signature alone cannot substitute
for the Nostr proof. No private key or subscriber data is public.

A persisted owner binding rejects wallet or Nostr owner changes. There is no
identity migration mechanism. A first-time viewer establishes its initial trust
from the independently verified manifest; existing followers also enforce their
pinned owner binding and announced manifest hashes on subsequent content loads.

## Private protocol

All messages use the existing NIP-17/NIP-59 seal and gift-wrap transport, with
inner rumor kind **24136** and an explicit project inbox handler. They grant no
DM contact authorization, invitation permission, or WebRTC consent.

Common JSON fields are `type`, `schema: 1`, `projectId`, `roomId`, `requestId`
(random 32-byte lowercase hex), and `at` (integer milliseconds). Message types:

- `web25-project-subscribe` and `web25-project-unsubscribe`: common fields only.
- `web25-project-ack`: adds `active` and `replyTo` (request ID). Acks must come
  from the pinned owner and match the current pending request and intent.
- `web25-project-update`: adds `version`, `infoHash`, `manifestHash`,
  `previousManifestHash`, `publishedAt` (ISO date), and optional `magnetURI` and
  `mirrorURL`. `manifestHash` hashes the complete newly signed manifest.

Unknown fields, malformed identities, unsafe URLs, future timestamps beyond five
minutes, and messages over 8 KiB are rejected. Owner registries cap subscriptions
at 1,000 identities per project. Requests are deduplicated by sender, request ID,
and monotonic request timestamp. A retry can receive another acknowledgement
without creating another subscription. Subscriber lists are never fanned out.

Updates require the pinned sender, project and room, exactly the next version,
and the preceding manifest hash. Duplicate/stale/unrelated updates are rejected.
Announced links remain **content verification required** until the normal loader
verifies the new `.torrentchain`; the new manifest must also match the announced
hash and pinned owners. Nostr authentication does not authenticate downloaded
bytes. Neither the final torrent infohash nor mirror goes into its own manifest.

The existing inbox reconnects on wallet unlock and requests retained history;
the original website need not be open. Project deduplication is committed with
project state, rather than marking a gift wrap handled before storage succeeds.
Out-of-order announcements are queued locally up to 64 versions ahead; missing
intermediate announcements must arrive before a hash-linked sequence advances. Delivery remains subject to
the configured inbox lookback and relay retention.

## Local persistence and failures

`web25-projects` IndexedDB holds one wallet-scoped, opaque-ID record, encrypted
with the existing worker-backed NIP-44-to-self operations. Unicode-safe chunks
keep each encryption below NIP-44 limits. It contains owned identities, successful
version history, subscriber state, followed projects, accepted version/hash,
updates, pending subscription requests, and per-recipient notification state.
Transactions are awaited through commit; operations serialize in-page and use
Web Locks across tabs where supported. A send lease limits concurrent retries;
an interrupted notification is retryable after one minute.

Only successful deployment finalization records a version. Notification failure
does not roll back or fail the torrent deployment. Pending/failed fan-out records
can be retried; unsubscribed identities are excluded. Interrupted subscription
requests can also be retried from their conversation. The publisher must retain
this browser's project registry to reuse identities and subscribers. Existing
wallet backup/export does **not** include this separate database: clearing site
data or moving to another browser loses these records. No new backup service
has been introduced. Without Web Locks, simultaneous writes from different tabs
are not coordinated; use one publishing tab.

## Verification

`tests/project-rooms.test.mjs` covers deterministic/distinct/stable rooms,
unchanged DM rooms, EVM recovery plus real Nostr proof signatures, tampering,
legacy manifests, non-contact subscribe/unsubscribe, private fan-out, persisted
state reload, replay/stale/unrelated/impersonated updates, owner continuity,
notification failure, and no self-infohash dependency. It also exercises real
NIP-59 transport and encrypted chunked IndexedDB reload/isolation.

Live public-relay retention, real wallet UI interaction, and two independent
browsers downloading and verifying a new WebTorrent/GoFile deployment still need
multi-peer acceptance testing. Automated protocol tests use local wallets,
mock relays/storage and the shipped service interfaces.
