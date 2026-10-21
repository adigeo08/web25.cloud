# 🤝 Cryptographic validity is not consent

Verifying an invitation proves the sender *is who they claim*. It does not
mean you want to talk to them — and anyone who knows your `npub` can
produce a perfectly valid offer. Answering one is not free: it reveals your full
ECIES public key, your EVM address, and, through ICE gathering, your machine's
network addresses.

So an invitation from anyone who is not already a trusted contact simply
**waits**. No answer is created, no ICE is gathered, and nothing is
sent back until you press Accept. Declining discards it silently — the sender is
not told, because telling them would confirm the address is live — and their
retries are dropped, so a refusal cannot be worn down by repetition.

::: feature-grid
- 🔔 Pending invitations show npub, name, EVM address and time
- 📨 A stranger's chat request arrives there too — one ask is enough
- ✅ Accept re-checks expiry and identity, then answers
- 🚫 Decline sends nothing at all
- 🤝 Trusted friends reconnect directly, crypto checks and all
- 🔐 Contacts are encrypted with your wallet identity
- 🔒 Lock the wallet and the contact list is unreadable
:::

Trust is authorization layered on top of authentication — it replaces none of the
existing checks. A trusted friend's invitation is still verified end to end, and
its identity tuple (Nostr key, ECIES key, EVM address) must both validate and match
what was stored, so taking over an `npub` does not inherit the trust
attached to it. Removing a contact is a local change only: they become unknown
again, and no key is deleted or rotated on either side.
