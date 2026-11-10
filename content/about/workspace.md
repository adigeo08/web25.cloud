# 🧰 Code workspace: git in the browser

Everything WEB25 keeps on disk lives in the browser's private file system
(OPFS), and the parts with a history are real git repositories, driven by
[isomorphic-git](https://isomorphic-git.org) — git written in JavaScript. Each
deployment, each site you reseed and each AI chat's code project is its own
repository, under `/web25/` in this browser.

::: feature-grid
- 🌱 One repository per deployment, per reseed and per chat project
- ✍️ A chat project's commits are authored by your Nostr address (`npub1…`)
- 💾 Files are written first, committed second: a slow CDN costs history, not data
- 🗂️ The Project panel moves, renames and creates files, saved as one commit
- ✏️ [CodeMirror](https://codemirror.net) 6 edits HTML, CSS and JavaScript
- 👀 Preview runs the project in a sandboxed, opaque-origin frame
- 🚀 **Deploy project** hands the files to Publish, signed like any site
:::

The canvas beside the chat opens a file in CodeMirror, with highlighting for
HTML, CSS and JavaScript, and **Ctrl/⌘+S** saves it back to the project as a
commit. Both libraries are fetched from esm.sh on first use and pinned to one
version; without the CDN the editor falls back to a plain text area with the
same Save, and files are still saved — only the commit waits.
