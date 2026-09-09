# GoFile guest mirror feasibility spike (2026-09-07)

## Confirmed contract used by the client

Guest upload uses `POST https://upload.gofile.io/uploadfile`. A first upload has
no authorization. A returning guest sends `Authorization: Bearer <guestToken>`;
WEB25 does not rely on the older multipart `token` form field. The client
accepts `id`, `parentFolder`, `parentFolderCode`, `downloadPage`, `servers`, and
`guestToken` from the upload response.

The mirror locator is `data.id`, the content id of the one uploaded mirror.
`parentFolder` is deliberately **not** the locator and is never sent back as
`folderId` on a later upload: a folder identifier addresses a growing set, so
publishing one would turn a single WEB25 link into an index of every site the
publisher has ever mirrored, and would make each new deployment ambiguous with
the ones before it. Each deployment is uploaded on its own, under its own
deterministic filename `web25-gofile-mirror-<infoHash>.json`, and the resolver
selects by that exact name. Hash verification still rejects the wrong bytes, but
it is not what picks the right mirror out of a locator that resolves to more
than one file.

`parentFolderCode` and the public `downloadPage` are retained as diagnostics
only; neither is shown in the UI or carried in a WEB25 link. They establish that
a public share is available. They do **not**, on their own, establish that
public content can be resolved or fetched programmatically, so
`publicShareAvailable` and `programmaticReadVerified` are separate result
fields.

Every request is bounded: 30s for upload, 20s for content resolution, 30s for
the mirror byte download, all via `AbortSignal.timeout`. A caller's own
cancellation stays distinguishable from a deadline (`aborted` vs `timeout`).
Mirror bytes are read as a bounded stream and refused past 64 MiB, whether the
size is declared in `Content-Length` or only discovered while reading.

A credential is provisioned at sign-in, not at upload time. `POST
https://api.gofile.io/accounts` is documented as unauthenticated with an empty
body: GoFile mints a guest account and returns its token, and that token is the
same kind of credential a dashboard API key is. WEB25 mints one the moment the
wallet unlocks — the only moment it can be encrypted to the identity — so a
mirror never has to mint one mid-deploy, and someone who has signed in can
authenticate a mirror read without ever having deployed. The call is
best-effort: a GoFile outage at sign-in is logged and nothing else.

Neither path ever replaces a credential the identity already holds. Sign-in
mints only when the store is empty, and a deployment persists the token an
upload issues only when it had none to authenticate with — otherwise the
account underneath a published locator could be swapped out from under it. The
one case that does replace is a credential GoFile refused, which has already
been cleared by then. The read-back uses whichever token actually owns the
upload.

Uploading is an **authenticated** call once an account exists, and GoFile draws
no distinction between a token created from the dashboard and the `guestToken`
an upload hands back: both go in as `Authorization: Bearer`. The upload sends
the stored credential when this identity has one, and otherwise lets GoFile mint
a guest account and keeps what comes back. Reading is a separate matter and
carries no credential at all — see below.

The bearer reaches only the upload endpoint and `api.gofile.io`, whose hosts are
constants in the client. It never reaches a storage server: reading is a public
route and needs no credential, so there is nothing to leak there.

## Reading: the storage route, not the content API

`GET /contents/{contentId}` is badged **Premium** in GoFile's reference — _"Direct
API access to listings is Premium-only: other tiers receive
`error-notPremium`"_ — and `error-notPremium` answers 401, the same code as
`error-token`, which is why a tier refusal first looked like a credential
problem. Creating a direct link is Premium too. There is no documented,
non-Premium API route for a program to read public content back.

WEB25 therefore reads the way GoFile's own web client does, straight from the
storage server holding the file:

```
https://<server>.gofile.io/download/web/<content uuid>/<filename>
```

Nothing is looked up to build it. The upload response already names the server
(`servers[0]`) and the content id (`id`), and the filename is derived from the
torrent hash, so the whole URL is determined before the first request. That is
also what selects the deployment: a wrong name is a 404 rather than the wrong
bytes. A mirror locator is consequently `<server>~<content uuid>` — `~` is
unreserved, so it survives a WEB25 link unencoded. Locators from earlier builds
were bare UUIDs, which name no server; they are refused with `invalid_locator`
rather than guessed at.

Two consequences worth stating plainly. The route is **not in the API
reference**: it is the web client's, so it can change without notice, and the
client validates its shape strictly for that reason. And it is **public**, so no
credential is sent to the storage host at all — a visitor resolves a mirror
exactly as the publisher verified it, with no account, no wallet, and nothing to
unlock. The credential is now only ever used for the upload.

## Reads go through WEB25's own Worker

Observed live: a browser request to the storage route is **redirected** to
`https://gofile.io/d/<uuid>`, and neither the storage server nor that page sends
an `Access-Control-Allow-Origin` header. A public CORS proxy did not rescue it
either — `api.allorigins.win/raw` answered without the header too.

Reads now go through a Cloudflare Worker of our own,
`gofile-cf-downloader.carlgray.workers.dev`, which does the three things a page
cannot: it reaches storage without CORS in its way, sets the `Cookie` a browser
forbids JavaScript from setting, and sends the custom `X-Website-Token` whose
preflight nothing answers. Its source and contract live in
[adigeo08/gofile-cf-downloader](https://github.com/adigeo08/gofile-cf-downloader);
the base URL is a constant here and overridable per instance.

The Worker holds **no GoFile credential**. Each caller sends their own as
`Authorization: Bearer`, so the transport barrier moves without the trust moving
with it. Two callers, two situations:

- A **publisher** verifying their own upload sends the credential that owns it —
  the stored one when it authenticated the upload, otherwise the one GoFile
  issued for it. The read-back therefore exercises the exact route a visitor
  will use, rather than a privileged shortcut.
- A **visitor** resolving a WEB25 link usually has no wallet unlocked and
  nothing stored, so a throwaway guest account is minted for that one read and
  never persisted. It grants nothing beyond reading public content, and a locked
  wallet could not hold it anyway.

A locator is the **share code** GoFile hands out for the upload — `1J53t9zb` in
a `https://gofile.io/d/1J53t9zb` link — taken from `parentFolderCode`, or read
out of `downloadPage` when that field is absent, and falling back to the file
UUID only when neither exists. Its case is part of it, so it is passed through
untouched; `1J53t9zb` and `1j53t9zb` are different links. The code names the
folder this one mirror was uploaded into, and since no folder is ever reused it
still names a single deployment.

Every form WEB25 has ever published keeps resolving: share codes, the bare
UUIDs published before them, and the `<server>~<uuid>` links minted while reads
went straight to storage, whose prefix is accepted and dropped. UUIDs are
case-insensitive by definition, so those are normalised; share codes are not.

The Worker's error vocabulary is translated rather than passed through.
`missing_token` and `listing_refused` become a credential problem;
`file_not_found` a missing mirror; `download_refused` an unavailable one. The
judgements the Worker makes about the bytes themselves — `download_page_returned`
and `size_mismatch`, and the trust and redirect refusals `untrusted_link`,
`untrusted_redirect`, `too_many_redirects`, `invalid_link`, `invalid_redirect`
and `unreadable_response` — all become `mirror_untrusted`. Every one of them
throws, so a mirror the Worker will not vouch for aborts the fallback rather
than degrading into something rendered unverified.

`GoFileService` carries bytes and never reads them: no sniffing, no
decompression, no transformation. A mirror is UTF-8 JSON and a site bundle is
gzip, and both cross it identically — which is what lets the info-hash, piece,
TorrentChain and bundle checks downstream stay the only thing that decides
whether anything renders.

What this costs is a service WEB25 operates. That is a real dependency, but it
is ours: no third party sees the traffic, and the fallback stops depending on a
free public proxy's uptime.

## The credential lives in a browser

The reference is explicit: _"The token authenticates as the account itself —
anyone holding it has full access. Keep it server-side: never embed it in public
client-side code."_ WEB25 has no server, so its credential is necessarily
client-side. It is never embedded in source or shipped in a build: it is minted
per identity at sign-in and encrypted to that identity's Nostr key before it
touches IndexedDB, so a locked wallet cannot read it and a second identity in
the same browser cannot decrypt it. That is meaningfully stronger than what the
warning is aimed at, and still weaker than server-side custody. It is a
deliberate trade for a feature that is optional and best-effort by design, and
it is another reason not to put a paid Premium token here.

A mirror is only published as a locator once it has been **read back
publicly**: after uploading, the client resolves its own locator by the same
route a receiver would and byte-compares the result. Uploading proves nothing
about resolvability, and a locator nobody else can fetch is worse than no
locator at all, so a failed or mismatched read-back reports the mirror as
unavailable and the deployment falls back to `?orc=<hash>`. Until the live
questions below are answered, expect this check — not the upload — to be what
decides whether a mirror exists.

## Required cross-guest experiment

The spike is designed to test both forms of Guest A's public folder identifier:

1. Guest A uploads a small disposable file and receives `parentFolder`,
   `parentFolderCode`, and `guestToken`.
2. Guest B performs a separate anonymous upload to obtain a distinct free guest
   identity.
3. With only Guest B's bearer token, request both
   `GET https://api.gofile.io/contents/<A parentFolder>` and
   `GET https://api.gofile.io/contents/<A parentFolderCode>`.
4. If either returns A's file metadata and a byte URL, separately issue
   browser-origin CORS fetches for the content API and byte URL and record their
   `Access-Control-*` response headers.
5. Delete both disposable folders if the public API permits it.

Tokens must remain in process-local variables, be redacted from output, and
never enter fixtures, command lines, URLs, or committed files.

## Execution result in this environment

The live spike could not reach the first guest-upload request. The environment's
mandatory CONNECT proxy returned HTTP 403 for `upload.gofile.io`; bypassing the
proxy also failed because external DNS is unavailable. No GoFile API response,
guest token, or temporary content was created.

Therefore this run does **not** classify GoFile as WORKS, PARTIAL, or BLOCKED.
In particular, lack of an executable network path is not evidence that
cross-guest reads require Premium or unsupported authorization. The result is
**INCONCLUSIVE (test environment)**, and `programmaticReadVerified` remains
`false` strictly as an unverified capability flag.

Because of that, the mirror is opt-in per deployment: the deploy wizard ships
the checkbox off, and a fresh deployment is WebTorrent-only unless the publisher
asks for a mirror. Nothing remembers the choice between deployments.

WebTorrent is tried first, always. Every route to the mirror runs behind the
same retry budget — five attempts with exponential backoff, over WebRTC through
the trackers in the magnet — including a synchronous failure to add the torrent
at all, which used to reach for the mirror on the first attempt. GoFile is what
is left when peer discovery has genuinely been given its chance, never a
shortcut around it.

Runtime failures remain best-effort in the strict sense. The successful torrent
deployment is rendered and persisted _before_ any GoFile request begins, so a
slow, failing, or timed-out mirror can only cost the fallback: the deployment
stays successful and the shared link falls back to `?orc=<hash>`. Receivers
attempt the public content endpoint only after the normal WebTorrent retry
policy reaches terminal failure, and the loading overlay always terminates. Any
returned mirror is still untrusted and must pass torrent info-hash, piece-hash,
TorrentChain, and bundle verification before the existing sandbox renderer can
see it.

The automated suite covers all of this offline against mocked GoFile responses
and never contacts a real endpoint. Live endpoint, CORS, and cross-guest
interoperability validation remains outstanding and is tracked separately from
the test suite.
