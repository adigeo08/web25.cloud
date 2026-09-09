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

## Reads go through a CORS proxy

Observed live on 2026-09-09: a browser request to the storage route is
**redirected** to `https://gofile.io/d/<uuid>`, the human download page, and
neither the storage server nor that page sends an `Access-Control-Allow-Origin`
header. So a page on another origin cannot read a mirror directly, whatever URL
it uses — this is the same wall the Premium listing route hit, one layer down.

Mirror reads therefore go through a CORS proxy, `api.allorigins.win` by default
and configurable so it need not be a public one. `/raw` is used first because it
returns the body untouched, which is what piece-hash verification needs; `/get`
is a fallback for when `/raw` is unavailable, and only works here because a
mirror is UTF-8 JSON rather than arbitrary bytes.

**Only reads.** The upload and the account call always go straight to GoFile:
both carry `Authorization: Bearer`, and routing a token through a third party
would hand over the whole account. Neither has a CORS problem to solve anyway —
`api.gofile.io` is CORS-enabled and the upload endpoint accepts the request as
it is. A test asserts no credentialed call is ever proxied.

What this costs is honest to state: an optional fallback transport now depends
on a free third-party service, with its uptime, its rate limits, and its
operator able to see traffic that is public by construction but was previously
nobody else's business. It is one more reason the mirror stays opt-in and
best-effort, and a reason to point `readProxy` at your own deployment if the
fallback ever matters more than convenience.

Because a proxy follows redirects server-side, the likeliest wrong answer is the
download page rather than the file. That case is detected by its HTML and named
as such, instead of surfacing as malformed JSON several layers later.

Per the conventions in the reference: content ids are UUIDs and that is what a
locator carries; share codes address the same content but grant no extra access,
so they are not used here; and all of this is independent of folder listings,
which is the paginated, Premium-gated surface we no longer touch.

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
