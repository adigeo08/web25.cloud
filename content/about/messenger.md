# 💬 Direct Messenger: search an address, start a chat

Messaging UX started from
[michal-wrzosek/p2p-chat](https://github.com/michal-wrzosek/p2p-chat)
and replaced its manual offer/answer step entirely. You enter someone's Nostr
address, and the encrypted WebRTC invitation is delivered for you through public
Nostr relays — no magnet links or key pasting.

::: feature-grid
- 🔍 Search by `npub`, then request a chat
- 🎁 Invitations sealed and gift-wrapped (NIP-44 / NIP-59)
- 🙈 SDP, ICE, EVM address and keys never publicly readable
- 🛑 An unknown peer is never auto-answered — you decide
- 🪪 Peer verification from public key to EVM address
- ✍️ Per-message signatures verified on receive
- 🧊 STUN used: `stun:stun.l.google.com:19302`
:::

WebRTC stays the preferred transport. If a direct connection cannot be
established, messages fall back to the relays — still signed and ECIES-encrypted
exactly as before, with NIP-44 on top. The chat header says which path is in use:
**Connected · WebRTC** or **Connected · Nostr** — one indicator, green either way.
