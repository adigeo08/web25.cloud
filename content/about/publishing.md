# 📦 Publishing: Bundle pipeline + .torrentchain

Static-site deploys run through a bundle pipeline (default: gzip), then attach a signed `.torrentchain`
manifest carrying publisher identity and integrity metadata.

::: feature-grid
- 🗜️ Default bundle mode: gzip
- 🧾 Signed .torrentchain generated at publish time
- ✍️ Publisher EVM identity embedded in deploy artifact
- ✅ Identity/integrity checks applied during load
:::
