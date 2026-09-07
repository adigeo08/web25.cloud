# GoFile guest mirror feasibility spike (2026-09-07)

## Confirmed contract used by the client

Guest upload uses `POST https://upload.gofile.io/uploadfile`. A first upload has
no authorization. A returning guest sends `Authorization: Bearer <guestToken>`
and multipart `folderId=<parentFolder UUID>`; WEB25 does not rely on the older
multipart `token` form field. The client accepts `id`, `parentFolder`,
`parentFolderCode`, `downloadPage`, `servers`, and `guestToken` from the upload
response.

The documented contents route uses the `parentFolder` content UUID, so that is
represented as the prospective `mirrorLocator`; `parentFolderCode` and the
public `downloadPage` are retained as sharing metadata. These establish that a
public share is available. They do **not**, on their own, establish that public
content can be resolved or fetched programmatically, so
`publicShareAvailable` and `programmaticReadVerified` are separate result
fields.

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

The deployment now proceeds on the publisher's explicit acceptance of this
uncertainty. Runtime failures remain best-effort: the torrent deployment stays
successful, and receivers attempt the public content endpoint only after the
normal WebTorrent retry policy reaches terminal failure. Any returned mirror is
still untrusted and must pass torrent info-hash, piece-hash, TorrentChain, and
bundle verification before the existing sandbox renderer can see it.
