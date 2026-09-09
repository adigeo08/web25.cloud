# Protected content and capability grants

> Status: implemented. `.torrentchain` stays `web25-torrentchain-v1`; there is
> no v2. This document describes what the manifest carries, how a protected
> fragment is produced, and what a viewer must prove before one opens.

A Web25 site is a signed static bundle that anyone can fetch. Protecting part of
it therefore cannot mean "hide it from the page" — the bytes travel to everyone.
It means: publish ciphertext, and publish, in the same signed manifest, the list
of public keys that can unwrap the key to it.

The design is inspired by UCAN: a capability (`decrypt`) is delegated from the
owner to a recipient, and the delegation is self-describing and verifiable
offline, with no server anywhere in the loop.

## What the manifest carries

```jsonc
{
  "schema": "web25-torrentchain-v1",
  "siteId": "uuid",
  "owner": {
    "evmAddress": "0x…",
    "eciesPublicKey": "04…",   // uncompressed secp256k1
    "nostrPublicKey": "…",     // x-only view of the same key
    "npub": "npub1…"
  },
  "filesHash": "…",             // digest of manifest.files
  "protectedAssets": [
    {
      "assetId": "uuid",
      "source": { "path": "index.html", "locator": { /* structural only */ } },
      "contentHash": "…",
      "contentSalt": "…",
      "cipherHash": "…",
      "cipherPath": ".web25/protected/<assetId>.bin",
      "cipher": { "algorithm": "AES-256-GCM", "iv": "…", "aad": "…" },
      "grants": [
        {
          "recipientPublicKey": "04…",
          "recipientAddress": "0x…",
          "can": ["decrypt"],
          "wrappedKey": "…",
          "grantHash": "…"
        }
      ]
    }
  ]
}
```

All of it is **inside** the signed payload. Access control that sits beside a
signature is not access control: anyone who can serve the file can rewrite it.
`manifest.files` stays outside for readability, but the payload carries its
digest, so editing the file list breaks the signature too.

Assets are sorted by `assetId` and grants by `recipientPublicKey` before
signing, so the same site always produces the same signed message regardless of
the order the publisher happened to click in.

`verifyTorrentChainManifest` recomputes the canonical message from the payload
and refuses a manifest whose `message` field disagrees with it — otherwise a
tampered payload could travel with the original signed message and pass.

### What the published locator does *not* say

Resolving a selection needs the exact text, the text before it and the text
after it. Publishing those would publish the very thing being protected, so the
manifest records only the structural half: container path, offsets and length.
The full locator exists in memory during authoring and is never written out.

## Producing a protected fragment

Per fragment, exactly once — recipients differ only in the envelope around the
same content key, so adding a recipient never re-encrypts and can never produce
a second ciphertext that drifts from the first:

```text
CEK         = 32 random bytes
iv          = 12 random bytes
contentSalt = 16 random bytes
contentHash = SHA256(contentSalt || plaintext)
AAD         = canonical({ schema, siteId, assetId, contentHash })
ciphertext  = AES-256-GCM(CEK, plaintext, AAD)
cipherHash  = SHA256(ciphertext)
```

The ciphertext is stored at `.web25/protected/<assetId>.bin`, so it is hashed
into the file list and the bundle like any other file. The fragment is replaced
in the staged HTML by:

```html
<web25-protected data-asset-id="<uuid>"></web25-protected>
```

Per recipient:

```text
envelope   = { schema: "web25-protected-key-v1", siteId, assetId,
               contentHash, cipherHash, cek }
wrappedKey = ECIES(recipientPublicKey, canonical(envelope))
grantHash  = SHA256(canonical(siteId, assetId, contentHash, cipherHash,
                              recipientPublicKey, wrappedKey, ["decrypt"]))
```

The owner is added to every asset's recipient list automatically and cannot be
removed from the UI: a publisher who cannot read their own site back has
silently destroyed content.

### Why cross-swapping fails

- **wrapped key from asset A on asset B** — the envelope names asset A, and the
  worker compares it against the asset it was asked to open.
- **ciphertext from asset A on asset B** — B's `cipherHash` comes from the
  signed manifest, and A's bytes do not hash to it. Past that, the AAD names B
  while the key was bound to A, so the GCM tag fails too.
- **a grant moved to another recipient, asset or site** — `grantHash` covers all
  three, and verification recomputes it.

## Mapping a selection back to the source

Re-serialising through the browser's DOM would not do: it normalises attribute
quoting, drops duplicates and injects implied elements, so the published file
would differ from the file the publisher chose, in ways that vary by browser.

`src/torrent/AuthoringDom.js` therefore keeps each node's raw source text. A
document parsed and serialised again without edits comes back byte for byte, and
the only differences in a protected build are the fragments actually replaced.
Preview-only ids (`data-web25-node`) are added for rendering and stripped before
the final files are built.

A locator carries four independent pieces of evidence — file path, preview node
id, character offsets, and the exact text with its surrounding context — and
resolution recomputes all of it. If any piece disagrees, the selection is
rejected. Selections are resolved against the pristine document first and
applied back to front, so an earlier fragment's offsets are never shifted by a
later replacement, and overlapping selections are refused rather than merged.

Content that only runtime JavaScript produces is out of scope: it cannot be
mapped safely back to a staged file, so the authoring preview renders without
the site's scripts.

## Viewing

Order of operations, all before anything renders:

1. torrent / GoFile / `.torrentchain` retrieval and integrity checks (unchanged)
2. manifest signature
3. bundle / file integrity
4. `cipherHash` for every protected asset, against the bundle that shipped
5. grant hashes and bindings
6. render

A protected fragment renders as `🔐 Decrypt` and never opens on its own. On an
explicit click, the sandbox sends one asset id over the bridge; everything else
comes from the verified manifest held by the application.

| Viewer state | What happens |
| --- | --- |
| wallet locked | "Unlock your local wallet…" — never "no access" |
| unlocked, no grant | no crypto attempted; the verified owner `npub` is shown |
| unlocked, grant | `PROTECTED_ASSET_DECRYPT` in the wallet worker |

The worker operation is narrow on purpose. It is not "decrypt these bytes": it
re-hashes the ciphertext, opens the envelope with the private key it already
holds, checks the envelope's `siteId`, `assetId`, `contentHash` and `cipherHash`
against the request, rebuilds the AAD itself, decrypts, and re-checks the
plaintext digest before returning the fragment. The private key and the content
key never leave the worker.

Nothing decrypted is persisted: not to IndexedDB, `localStorage`, the Service
Worker cache or the PeerWeb cache. Plaintext exists only in memory and in the
sandboxed frame's DOM.

### The Nostr side is deliberately not built yet

A viewer without a grant is shown the author's verified `npub` and nothing more.
The access-request messaging flow over Nostr is a separate feature; exposing the
verified address is what this change owes it.

## Where the code lives

| File | Role |
| --- | --- |
| `src/torrent/CanonicalJson.js` | deterministic serialisation and hashing |
| `src/torrent/ProtectedAssetProtocol.js` | the crypto model, validation, unwrapping |
| `src/torrent/AuthoringDom.js` | round-trip-faithful HTML tree |
| `src/torrent/ProtectedTextLocator.js` | selection → staged source, placeholders |
| `src/torrent/ProtectedSiteBuilder.js` | staged site → protected site |
| `src/torrent/TorrentChainProtocol.js` | the signed manifest |
| `src/auth/walletWorkerProtocol.js` | `PROTECTED_ASSET_DECRYPT` validation |
| `src/auth/walletWorkerCore.js` | the worker-side operation |
| `src/core/renderer/ProtectedAssetRuntime.js` | viewer-side verification and gating |
| `src/ui/publish/ProtectPreviewPanel.js` | the Preview & Protect DOM |
| `src/core/bootstrap/Lifecycle.js` | the deploy step itself |

Tests: `tests/protected-assets.test.mjs`,
`tests/torrentchain-protected-manifest.test.mjs`,
`tests/protected-deploy-flow.test.mjs`,
`tests/protected-site-loading.test.mjs`.
