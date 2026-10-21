# 🛡️ Security profile

WEB25.cloud validates signed publisher metadata and sanitizes rendered HTML with DOMPurify at load time.
The sanitizer is intentionally configured in a compatibility-oriented profile (more permissive than strict defaults)
to support richer static websites.

::: feature-grid
- 🧾 Signed-manifest verification before render gates
- 🧼 DOMPurify sanitization applied to loaded HTML
- 🧩 Extended tag/attribute/protocol allowance for compatibility
- ⚖️ Explicit trade-off: broader compatibility vs stricter hardening
:::
