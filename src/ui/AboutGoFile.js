// @ts-check

/**
 * Keep the public About copy aligned with the current runtime transport order
 * without coupling product documentation to the large static index template.
 */
export function installGoFileAboutCopy() {
    const aboutGrid = document.querySelector('#tab-about .about-bento');
    if (aboutGrid && !document.getElementById('about-gofile-transport')) {
        const article = document.createElement('article');
        article.id = 'about-gofile-transport';
        article.className = 'about-card';
        article.innerHTML = `
            <h3>⚡ GoFile: ephemeral HTTP acceleration</h3>
            <p>
                WEB25 loads sites in the order <strong>local cache → GoFile → WebTorrent</strong>.
                A GoFile mirror is a CDN-like fast path after a cache miss, not the source of truth:
                the client still verifies the mirrored torrent locally before anything renders.
            </p>
            <div class="feature-grid">
                <div class="feature">💾 Cache first for instant repeat loads</div>
                <div class="feature">⚡ GoFile second for fast HTTP delivery when a mirror locator exists</div>
                <div class="feature">🌐 WebTorrent / P2P remains the resilient fallback</div>
                <div class="feature">🧪 Mirror bytes are verified against torrent metadata and pieces</div>
                <div class="feature">🕒 Guest mirrors are best-effort and intentionally ephemeral</div>
                <div class="feature">🔐 Guest account tokens are stored only as wallet-encrypted local ciphertext</div>
            </div>
            <p>
                The GoFile guest credential is provisioned per local WEB25 identity. WebAuthn PRF protects
                the wallet vault; the unlocked wallet worker then encrypts the GoFile token to the identity
                using NIP-44 before the ciphertext is stored in IndexedDB. A locked wallet cannot read it.
            </p>
            <p>
                Mirrors are disposable by design. If a guest mirror expires or GoFile is unavailable,
                WEB25 falls through to WebTorrent without changing the deployment identity.
                <a href="https://github.com/adigeo08/web25.cloud/blob/main/docs/gofile-local-account-cdn.md"
                   target="_blank" rel="noopener noreferrer">Read the GoFile architecture notes</a>.
            </p>
        `;
        aboutGrid.appendChild(article);
    }

    // The old static copy predates the preferred loader. Correct it in the UI
    // so Browse describes the same cache → mirror → P2P behavior as the runtime.
    const browsePanel = document.getElementById('tab-browse');
    if (browsePanel) {
        for (const paragraph of browsePanel.querySelectorAll('p')) {
            if (paragraph.textContent?.includes('P2P is always tried first')) {
                paragraph.innerHTML =
                    '🎯 Enter a hash, <code>hash&amp;GoFileLocator</code>, or a complete WEB25 URL. ' +
                    'Resolution order is <strong>local cache → GoFile mirror → WebTorrent / P2P</strong>.';
                break;
            }
        }
    }
}
