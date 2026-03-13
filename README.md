# ☁️ Web25.Cloud ☁️

**🌐 Decentralized web platform built on top of PeerWeb 🌐**
--- evolving into a modular, wallet-aware peer-to-peer web stack ---

Web25.Cloud started as a fork and extension of PeerWeb, focused on
peer‑to‑peer static site hosting directly from the browser. The project
is now being actively refactored into a more maintainable modular
architecture, with the PeerWeb core already split into cleaner internal
modules as a first major step.

The current development phase focuses on integrating **viem** and
**wagmi** for wallet connectivity and identity‑related flows on top of
the decentralized hosting engine.

------------------------------------------------------------------------

# Project Status

Web25.Cloud is currently in an **active refactor and build phase**.

## Already Completed

-   The original PeerWeb-style monolithic core has been **modularized**
-   Internal logic split into smaller components:
    -   core orchestration
    -   renderer
    -   cache layer
    -   UI modules
    -   configuration
    -   utility modules
-   The project is no longer simply a PeerWeb fork
-   Architecture is being prepared for long‑term extensibility

## Currently in Development

-   **viem integration**
-   **wagmi integration**
-   wallet connection flows
-   ownership-aware architecture
-   modular app structure expansion

------------------------------------------------------------------------

# Current Features

## Peer-to-Peer Hosting

-   Drag & Drop website upload
-   Instant shareable URLs
-   No traditional hosting required
-   Browser-based seeding
-   Distributed peer-to-peer loading

## Performance

-   IndexedDB caching
-   Service Worker resource handling
-   Progressive loading
-   Automatic cleanup mechanisms

## Security

-   HTML sanitization
-   Input/hash sanitization
-   Sandboxed iframe rendering
-   Resource validation

## UX

-   Toast notifications
-   Debug logging
-   PWA support
-   Responsive interface

------------------------------------------------------------------------

# Development Roadmap

## 1. PeerWeb Core Refactor

The first step was breaking the monolithic `peerweb.js` architecture
into modular components.

Goals:

-   remove monolithic code
-   isolate responsibilities
-   improve maintainability
-   prepare for future features

This step has already begun and forms the foundation of the project.

------------------------------------------------------------------------

## 2. Wallet & Identity Layer

Current active development focuses on:

-   wallet connectivity via **wagmi**
-   blockchain interaction utilities via **viem**
-   ownership‑aware application flows
-   wallet‑based application state

------------------------------------------------------------------------

## 3. Identity‑Aware Web Experiences

Future work may include:

-   signed actions
-   ownership verification
-   gated content flows
-   identity-linked site behavior

------------------------------------------------------------------------

## 4. Messaging Layer

A decentralized messaging layer is planned for a later stage.

The messaging architecture will be **inspired by the p2pt JavaScript
library**, which uses WebTorrent trackers for peer discovery.

Expected research areas:

-   peer discovery models
-   direct messaging channels
-   encrypted message exchange
-   browser-native peer communication patterns

This system will not rely on centralized messaging infrastructure.

------------------------------------------------------------------------

# Quick Start

## Host a Website

1.  Open Web25.Cloud
2.  Drag your site folder into the upload area
3.  The site is packaged for peer distribution
4.  Share the generated link

## Load a Website

Enter a site hash or open:

https://web25.cloud?orc=HASH

## Debug Mode

Enable debug logs:

https://web25.cloud?orc=HASH&debug=true

------------------------------------------------------------------------

# Website Requirements

Sites should be:

-   static
-   contain an `index.html`
-   use relative internal paths
-   include assets like HTML, CSS, JS, images, and fonts

------------------------------------------------------------------------

# Project Structure

Example structure:

web25.cloud/ │ ├── index.html ├── styles.css ├── peerweb-sw.js ├──
manifest.json ├── package.json ├── README.md │ ├── src/ │ ├── config/ │
├── constants/ │ ├── core/ │ │ ├── torrent/ │ │ ├── renderer/ │ │ ├──
serviceworker/ │ │ └── navigation/ │ ├── cache/ │ ├── ui/ │ └── utils/ │
└── scripts/

The architecture separates:

-   core orchestration
-   torrent logic
-   rendering
-   service worker integration
-   caching
-   UI components
-   utilities
-   wallet integrations
-   future messaging modules

------------------------------------------------------------------------

# How It Works

## Upload

-   Files are packaged
-   A unique content identifier is generated
-   The browser becomes the first peer

## Loading

-   Resource requests resolved through the peer network
-   Files downloaded from available peers
-   Cached locally for faster future loads

## Rendering

-   HTML sanitized
-   resources processed
-   sites rendered in sandboxed iframe environments

------------------------------------------------------------------------

# Wallet Integration Work

Current focus:

## viem

Used for chain interaction utilities.

## wagmi

Used for wallet connection flows and frontend wallet state management.

The goal is to integrate wallet awareness cleanly into the modular
architecture rather than bolting it onto the old monolithic core.

------------------------------------------------------------------------

# Advanced Usage

## Debug Mode

Append:

?debug=true

Example:

https://web25.cloud?orc=HASH&debug=true

------------------------------------------------------------------------

# Vision

Web25.Cloud is evolving from a PeerWeb experiment into a modular
decentralized web platform.

Future capabilities may include:

-   wallet‑aware websites
-   ownership‑verified content
-   protected client-side content
-   decentralized messaging
-   modular peer web applications

The first step in this direction was replacing the original monolithic
architecture with a modular foundation.

------------------------------------------------------------------------

# License

MIT License.

See LICENSE file for details.

------------------------------------------------------------------------

# Acknowledgments

-   PeerWeb
-   WebTorrent
-   DOMPurify
-   viem
-   wagmi
-   p2pt
