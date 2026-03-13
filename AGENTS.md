# Task pentru Codex: refactorizare UI + integrare minimă viem/wagmi pentru autentificare, publicare torrent și semnare torrent în browser

## Context

Aplicația permite publicarea și încărcarea de site‑uri prin torrent
direct din browser. Următorul pas este introducerea unui sistem minim de
identitate bazat pe wallet, astfel încât publicarea unui torrent să
poată fi asociată unei identități și semnată criptografic.

Acest task are două obiective principale:

1.  refactorizarea UI pentru a introduce un flux clar de identitate și
    publicare;
2.  integrarea minimă **viem + wagmi** pentru conectare wallet și
    semnare.

Nu implementa smart contracts sau backend de autentificare.

------------------------------------------------------------------------

# Obiectiv

Aplicația trebuie să suporte două tipuri de identitate:

### Wallet extern

-   conectare prin **WalletConnect**
-   afișare adresă conectată
-   posibilitate de **sign message** pentru payload‑ul de publicare
    torrent

### Wallet local în browser

-   utilizatorul poate apăsa **Register**
-   aplicația generează wallet nou
-   utilizatorul primește **seed phrase**
-   wallet‑ul este stocat persistent
-   cheia privată nu este stocată în clar
-   cheia este criptată și protejată folosind WebCrypto + IndexedDB
-   wallet‑ul poate semna payload‑uri torrent

------------------------------------------------------------------------

# Cerință de securitate

Cheia privată EVM nu trebuie stocată în clar.

Model recomandat:

1.  la register se generează seed phrase;
2.  seed phrase se afișează utilizatorului o singură dată;
3.  cheia privată este criptată;
4.  cheia de criptare este gestionată prin WebCrypto;
5.  cheia WebCrypto trebuie să fie `CryptoKey` non‑extractable dacă este
    posibil;
6.  cheia criptată se stochează în IndexedDB;
7.  cheia privată este decriptată doar temporar în memorie pentru
    signing.

------------------------------------------------------------------------

# UI Requirements

UI trebuie refactorizat în trei zone clare:

## Identity / Auth

-   Connect Wallet
-   Register Local Wallet
-   Unlock Local Wallet
-   Disconnect
-   Delete Local Wallet

## Publish

-   selectare fișiere
-   creare torrent
-   preview metadate
-   semnare payload
-   publicare

## Browse / Load

-   comportamentul existent de încărcare site rămâne

------------------------------------------------------------------------

# Publish Signing

Payload‑ul semnat trebuie să fie determinist.

Exemplu structură:

-   torrentHash
-   siteName
-   createdAt
-   version
-   publisherAddress
-   contentRoot
-   chainId

Payload‑ul trebuie serializat predictibil.

------------------------------------------------------------------------

# Structură recomandată

    src/
    ├── auth/
    │   ├── AuthController.js
    │   ├── AuthState.js
    │   ├── ExternalWalletService.js
    │   ├── LocalWalletService.js
    │   ├── SeedPhraseService.js
    │   ├── SecureKeyStore.js
    │   └── SigningService.js
    │
    ├── ui/
    │   ├── auth/
    │   │   ├── AuthPanel.js
    │   │   ├── ConnectWalletModal.js
    │   │   ├── RegisterWalletModal.js
    │   │   ├── SeedPhraseScreen.js
    │   │   ├── UnlockWalletModal.js
    │   │   └── IdentityBadge.js
    │   │
    │   ├── publish/
    │   │   ├── PublishPanel.js
    │   │   ├── PublishReviewModal.js
    │   │   └── SignatureStatus.js
    │
    ├── web3/
    │   ├── wagmiConfig.js
    │   ├── walletConnect.js
    │   ├── viemClients.js
    │
    ├── torrent/
    │   ├── TorrentPublishService.js
    │   ├── TorrentSignaturePayload.js

------------------------------------------------------------------------

# Biblioteci

## wagmi

folosit pentru:

-   wallet connectors
-   WalletConnect
-   account state
-   signing cu wallet extern

## viem

folosit pentru:

-   wallet utilities
-   signing
-   address helpers

## WalletConnect

-   trebuie configurat cu `projectId`
-   configurat prin config/env

------------------------------------------------------------------------

# Persistență

## wallet extern

persistența este gestionată de wagmi.

## wallet local

store persistent cu:

-   walletId
-   address
-   encryptedPrivateKey
-   createdAt
-   lastUsedAt

Seed phrase:

-   afișat la register
-   nu trebuie stocat în clar

------------------------------------------------------------------------

# Stări auth

-   anonymous
-   external_connected
-   local_registered_locked
-   local_unlocked
-   signing
-   publishing

------------------------------------------------------------------------

# Non Goals

Nu implementa:

-   smart contracts
-   token gating
-   backend auth
-   multi wallet management
-   hardware wallets

------------------------------------------------------------------------

# Acceptance Criteria

1.  UI separat pentru auth.
2.  WalletConnect funcțional.
3.  Address vizibil.
4.  Semnare mesaj test.
5.  Register wallet local.
6.  Seed phrase afișat.
7.  Persistență wallet local.
8.  Cheia privată nu este stocată în clar.
9.  WebCrypto + IndexedDB utilizat.
10. Signing funcțional pentru publish.
11. Publish legat de identitate.
12. Fără monoliți noi.
