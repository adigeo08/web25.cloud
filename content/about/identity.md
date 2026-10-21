# 🪪 Identity: one local key, three addresses

The identity model is local-first and is inspired by
[mylofi/local-data-lock](https://github.com/mylofi/local-data-lock):
key material stays in-browser and WebAuthn passkeys gate unlock/signing sessions.
A single secp256k1 key backs all three identities shown on the Account page —
there is no second seed and no second private key.

::: feature-grid
- 🏷️ EVM address for signing deploys — `0x…`
- 🔑 ECIES public key for encrypted messaging — `04…`
- 🪐 Nostr address for being reached by others — `npub1…`
- 🔐 Local wallet, no mandatory external wallet extension
- 🧬 WebAuthn PRF unlock with Face ID / Touch ID / device PIN
- 🗝️ Several passkeys, one wallet — each wraps the same key
- 🧹 Session key lifecycle with explicit lock/clear behavior
:::

The passkey does more than gate the unlock — it is what the key is wrapped
*with*. Web25 requires the WebAuthn **PRF** extension, and the
secret the authenticator returns during a user-verified assertion is stretched
through HKDF-SHA256 into a non-extractable AES-GCM key that wraps the vault. That
secret never leaves the call stack and is never written to storage, so nothing
persisted on the device is enough on its own to derive the wallet. A browser or
security key without PRF is refused rather than quietly handed a weaker path.

The Account page shows all three side by side, each with its own copy button.
The Nostr address can be added or removed there: removing it takes you off the
relays and hides the address, and adding it back restores the same
`npub` — because it was never a separate key to begin with.
