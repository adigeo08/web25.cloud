# ☁️ Web25.Cloud ☁️

**🌐 Decentralized web platform powered by PeerWeb — with EVM identity, ownership & encrypted messaging 🌐**

Web25.Cloud builds on top of [PeerWeb](https://peerweb.lol) to bring a complete decentralized web experience: host static sites peer-to-peer, own your content via EVM wallets (inspired by ZeroNet), protect private content with token-gated encryption, and communicate securely with e2e encrypted DMs — all without centralized servers.

## 🗺️ Roadmap

### 1. 🔐 IAM — EVM Identity & Access Management (via wagmi)

- **Wallet-based website ownership** — inspired by ZeroNet: sign your site with an EVM wallet; ownership is verifiable on-chain.
- **Private content with token-gated encryption** — encrypt content so that only holders of a specific EVM token can decrypt and access it.

### 2. 💬 Messaging Channel (DMs)

- **Peer Discovery via WebTorrent** — uses the [p2pt](https://github.com/subins2000/p2pt) library built on WebTorrent trackers.
- **Invitation screens & chat UI** — clean invite flow with end-to-end encrypted messaging.
- **E2E Encryption** — all DMs encrypted client-side; no server ever sees message content.

---

## ✨ Current Features (PeerWeb Core)

### 🚀 Core Features

- **Drag & Drop Upload** — Simply drag your website folder to host it
- **Instant Sharing** — Get a shareable Web25.Cloud link immediately
- **Zero Hosting Costs** — No servers, no monthly fees, completely free
- **Censorship Resistant** — Distributed across peer-to-peer networks
- **Always Available** — Works as long as there are online peers

### 💾 Smart Technology

- **Intelligent Caching** — Lightning-fast loading with IndexedDB storage
- **Service Worker Magic** — Seamless resource loading and offline support
- **Progress Tracking** — Real-time download progress and peer statistics
- **Auto Cleanup** — Expired cache automatically cleaned after 7 days

### 🛡️ Security & Safety

- **XSS Protection** — All HTML sanitized with DOMPurify
- **Hash Sanitization** — Torrent hashes sanitized to prevent XSS attacks
- **Sandboxed Execution** — Sites run in isolated iframe environments
- **Content Validation** — All resources validated before display
- **External Link Preservation** — Social media and external links work normally
- **Memory Leak Prevention** — Automatic cleanup of timeouts and object URLs

### 🎯 User Experience

- **Toast Notifications** — Non-blocking, user-friendly notifications
- **Tab Navigation** — Clean tabbed UI for Host, Browse, IAM and Messaging
- **Advanced Torrent Creator** — Full-featured torrent creation tools
- **Debug Mode** — Detailed logging for developers and troubleshooting
- **PWA Support** — Install as a Progressive Web App on any device
- **Mobile Friendly** — Responsive design works on all devices

---

## 🚀 Quick Start

### 1. Host a Website

1. Open [Web25.Cloud](https://web25.cloud) in your browser
2. Drag your website folder to the upload area
3. Get your unique Web25.Cloud URL, and keep the tab open
4. Share the link with anyone, anywhere!

### 2. Load a Website

1. Enter a torrent hash in the load field
2. Or use a URL: `https://web25.cloud?orc=HASH`
3. Website loads directly from the peer network

### 3. Debug & Develop

Add `&debug=true` to any URL for detailed logging:

```
https://web25.cloud?orc=ABC123...&debug=true
```

---

## 📋 Website Requirements

Your websites should be:

- ✅ **Static content only** (HTML, CSS, JS, images, fonts, etc.)
- ✅ **Include index.html** (in root)
- ✅ **Use relative paths** for all internal resources
- ✅ **Responsive design** recommended for best experience

## 🏗️ Project Structure

```
web25.cloud/
├── index.html          # Main application interface (tabbed UI)
├── src/                # Modular source code
│   ├── core/           # Core orchestration and features
│   ├── ui/             # UI modules
│   ├── cache/          # Cache layer
│   └── config/         # Runtime configuration
├── peerweb.min.js      # Minified PeerWeb core
├── peerweb-sw.js       # Service Worker for resource handling
├── manifest.json       # PWA manifest for installable web app
└── README.md           # This file
```

## 🌐 How It Works

### Hosting & Loading (PeerWeb Core)

1. **Upload Process**
    - Your website files are packaged into a BitTorrent torrent
    - A unique hash identifies your site across the network
    - Files are seeded from your browser to the peer network

2. **Loading Process**
    - Service Worker intercepts resource requests
    - Files are downloaded via WebTorrent from multiple peers
    - Content is cached locally for instant future access

3. **Security Layer**
    - All HTML content sanitized with DOMPurify
    - Torrent hashes sanitized to prevent XSS
    - Sites run in sandboxed iframe
    - External links preserved and functional
    - Automatic memory cleanup on page unload

### EVM Identity (Coming Soon)

- Connect your EVM wallet via **wagmi**
- Sign your hosted site to prove ownership (ZeroNet-inspired)
- Gate content with ERC-20 / ERC-721 token checks
- Decrypt private content client-side once token ownership is verified

### Messaging (Coming Soon)

- Peer discovery via **WebTorrent** trackers (p2pt library)
- Invite links generate a shared topic hash for rendezvous
- Messages encrypted with **libsodium** / **ECIES** before sending
- No relay server — pure peer-to-peer delivery

---

## 🚀 Advanced Usage

### Debug Mode

Enable detailed logging by adding `&debug=true` to any URL:

```javascript
// Example debug output
[Web25.Cloud:DEBUG] Loading site with hash: abc123...
[Web25.Cloud:INFO] Found 15 files in torrent
[Web25.Cloud:DEBUG] Processing site early (95% complete)
[PeerWeb SW] Serving file: styles.css (2.4KB)
```

### Progressive Web App

Install Web25.Cloud on any device:

1. Visit [web25.cloud](https://web25.cloud)
2. Look for "Install" or "Add to Home Screen" in your browser
3. Use it like a native application

Features when installed:

- Standalone app window
- App icon on home screen/desktop
- Faster loading with caching
- Offline access to cached sites

---

## 🤝 Contributing

We welcome contributions! Here's how you can help:

### 🐛 Report Bugs

- Use the [Issues](https://github.com/adigeo08/web25.cloud/issues) tab
- Include browser version, steps to reproduce, and error messages
- Enable debug mode for detailed logs

### 💡 Suggest Features

- Open a [Feature Request](https://github.com/adigeo08/web25.cloud/issues/new)
- Describe the use case and expected behavior
- Check existing issues to avoid duplicates

### 🔧 Submit Code

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes and test thoroughly
4. Submit a Pull Request with detailed description

### 📝 Improve Documentation

- Fix typos or unclear instructions
- Add examples and use cases
- Translate to other languages

---

## 📖 Documentation

### Browser Support

- ✅ **Chrome/Chromium** 60+ (Recommended)
- ✅ **Firefox** 55+
- ✅ **Safari** 11+
- ✅ **Edge** 79+
- ❌ Internet Explorer (Not supported)

### WebTorrent Compatibility

- Uses WebTorrent for browser-based torrenting
- Compatible with standard BitTorrent protocol
- Supports DHT, PEX, and WebRTC connections

### Limitations

- **Static sites only** — No server-side processing
- **Browser hosting** — Sites available while browser tab is open
- **Peer dependency** — Requires active peers for availability
- **Large files** — May be slow for sites with many large assets

---

## 🔒 Security

### Content Sanitization

Multi-layer XSS protection:

- **HTML Sanitization** — All HTML content sanitized with DOMPurify
- **Hash Sanitization** — Torrent hashes stripped of non-hex characters
- **Script Injection Prevention** — Malicious scripts blocked
- **Dangerous Elements** — Unsafe HTML elements and attributes removed

### Sandboxed Execution

Websites run in sandboxed iframes with restrictions:

```html
<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe>
```

### External Resource Handling

- External links (social media, email, etc.) work normally
- CDN resources and external stylesheets load properly
- Only internal site resources are processed through the core engine

---

## 🌟 Use Cases

### 📝 Personal Websites

- Portfolio sites
- Blogs and documentation
- Landing pages
- Resume/CV sites

### 🔐 Ownership & Privacy

- Token-gated content (EVM)
- Wallet-signed articles and publications
- Subscriber-only resources

### 💬 Private Communication

- End-to-end encrypted direct messages
- Censorship-resistant chat channels
- Decentralized group coordination

### 🌍 Censorship Resistance

- News and journalism
- Political content
- Whistleblowing platforms
- Freedom of speech tools

---

## 🏆 Desktop Clients

For permanent hosting without keeping browser tabs open:

- 🪟 **Windows** — Web25.Cloud Desktop (Coming Soon)
- 🍎 **macOS** — Web25.Cloud Desktop (Coming Soon)
- 🐧 **Linux** — Web25.Cloud Desktop (Coming Soon)

---

## 📊 Technical Specifications

### Supported File Types

- **Documents**: HTML, CSS, JavaScript, JSON, XML
- **Images**: PNG, JPEG, GIF, SVG, WebP, ICO
- **Fonts**: WOFF, WOFF2, TTF, OTF, EOT
- **Media**: MP4, WebM, MP3, WAV
- **Other**: PDF and various binary formats

### Performance

- **Caching**: IndexedDB with 7-day expiration
- **Loading**: Progressive loading with 95% threshold
- **Piece Size**: Optimized based on total site size
- **Timeout**: 5-second request timeout with fallbacks
- **Memory Management**: Automatic cleanup of timeouts and object URLs
- **Resource Tracking**: All setTimeout calls tracked and cleaned up

### Network

- **Trackers**: 7+ built-in BitTorrent trackers
- **Protocols**: WebRTC, WebSocket, HTTP fallback
- **DHT**: Distributed Hash Table support
- **PEX**: Peer Exchange for discovery

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **[PeerWeb](https://peerweb.lol)** — The decentralized hosting engine this project builds upon
- **[WebTorrent](https://webtorrent.io/)** — Browser-based BitTorrent implementation
- **[p2pt](https://github.com/subins2000/p2pt)** — Peer-to-peer messaging over WebTorrent trackers
- **[wagmi](https://wagmi.sh/)** — React hooks for EVM wallet integration
- **[DOMPurify](https://github.com/cure53/DOMPurify)** — XSS sanitizer for HTML
- **[ZeroNet](https://zeronet.io/)** — Inspiration for wallet-based site ownership
- **BitTorrent Protocol** — Peer-to-peer file sharing foundation
- **Service Workers** — Enabling offline-first web applications

---

## 📞 Support

### Getting Help

- 📖 **Documentation**: Check this README and inline code comments
- 🐛 **Bug Reports**: Use GitHub Issues with debug logs
- 💬 **Community**: Join discussions in GitHub Discussions
- 📧 **Contact**: Create an issue for direct support

### Frequently Asked Questions

**Q: How long do sites stay available?**
A: Sites remain available as long as at least one peer is seeding them.

**Q: Can I update my website?**
A: Create a new torrent for updates. The hash will change with new content.

**Q: Is there a file size limit?**
A: No hard limits, but larger sites may load slower due to peer availability.

**Q: Can I use custom domains?**
A: Yes! Deploy Web25.Cloud to your domain and use `?orc=HASH` parameters.

**Q: Does it work offline?**
A: Cached sites work offline. New sites require internet for initial download.

**Q: When will IAM / Messaging be available?**
A: Both features are actively in development. Follow the repo for updates!

---

<div align="center">

**🌟 Star this project if you find it useful! 🌟**

Made with ❤️ for the decentralized web

</div>
