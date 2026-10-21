# 🛰️ Nostr relay: browser to relay, directly

The app talks straight to one public relay over a WebSocket. There is no Web25
relay, no proxy and no signalling server — just a rendezvous both sides agree on.

Two browsers can only meet on a relay they both use. Spreading over several
relays looks sturdier and behaves worse: a message accepted by one relay and a
subscription healthy on another never meet, and the invitation is lost while
every relay involved reports success. One relay makes finding each other
predictable, at an honest cost: while that relay is down, the messenger is
down with it.

::: feature-grid
- 🌐 Rendezvous: `wss://nos.lol`
- ⚙️ One array in the config — point it at your own relay
- 🧯 Reconnects with backoff; a dropped socket is not a lost session
- 🧬 Every event is re-verified locally; duplicates collapse
:::
