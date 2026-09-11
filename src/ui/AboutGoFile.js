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
            <h3>⚡ GoFile: ephemeral HTTP fallback</h3>
            <p>
                WEB25 loads sites in the order <strong>local cache → WebTorrent → GoFile</strong>.
                The swarm is what a deployment <em>is</em>, so it goes first and gets one short attempt;
                a GoFile mirror is the HTTP fallback for when nobody answers it, never the source of
                truth. The client verifies mirrored bytes against the torrent before anything renders.
            </p>
            <div class="feature-grid">
                <div class="feature">💾 Cache first for instant repeat loads</div>
                <div class="feature">🌐 WebTorrent second — one attempt, 8 seconds, no retry ladder</div>
                <div class="feature">⚡ GoFile third: fast HTTP bytes when the swarm is quiet</div>
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

    // Keep the Browse copy describing the same cache → P2P → mirror behaviour
    // as the runtime, without editing the large static template for it.
    const browsePanel = document.getElementById('tab-browse');
    if (browsePanel) {
        for (const paragraph of browsePanel.querySelectorAll('p')) {
            if (paragraph.textContent?.includes('P2P is always tried first')) {
                paragraph.innerHTML =
                    '🎯 Enter a hash, <code>hash&amp;GoFileLocator</code>, or a complete WEB25 URL. ' +
                    'Resolution order is <strong>local cache → WebTorrent / P2P → GoFile mirror</strong>.';
                break;
            }
        }
    }
}
