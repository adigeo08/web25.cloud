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

Resolving content is an **authenticated** call. `GET /contents/<id>` answers
401 without a credential — observed live on 2026-09-07 against a real upload —
and GoFile draws no distinction between a token created from the dashboard and
the `guestToken` an upload hands back: both go in as `Authorization: Bearer`,
the same scheme the upload itself already uses. The publisher's read-back sends
the token the upload just issued, falling back to the stored one. A visitor
sends the stored credential when this browser has one and attempts the read
unauthenticated otherwise, since someone opening a WEB25 link is usually not the
publisher and has no wallet unlocked.

The bearer reaches only `api.gofile.io`, whose host is a constant in the client.
It is never attached to the storage URL that the API names in its response:
that host is chosen by the response, and handing it a credential would leak one
wherever GoFile points.

Whether one guest's token can resolve another guest's public content — the
cross-guest question below — is what decides if the fallback works for anyone
but the publisher. It remains unanswered, and there is a second, sharper
version of it: at least one third-party account of the API states that direct
listing through `/contents` is Premium-only, with non-premium accounts getting
`status: "error-notPremium"` on a 200 response. That claim is uncorroborated —
a second source describing the same API does not mention any tier restriction,
and gofile.io could not be reached from the build environment to check. It is
why the client now carries the API's own status string into its error message
instead of a generic one: a single real deployment settles it.

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
