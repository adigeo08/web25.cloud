// @ts-check

export function processHtmlForPeerWeb(html, siteData, indexFileName, hash) {
    this.log('Processing HTML for PeerWeb...');

    // Create a temporary DOM to process the HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Get the base path of the index file
    const indexBasePath = indexFileName.includes('/')
        ? indexFileName.substring(0, indexFileName.lastIndexOf('/') + 1)
        : '';

    // Process different types of elements
    const elementsToProcess = [
        { selector: 'link[href]', attr: 'href' },
        { selector: 'script[src]', attr: 'src' },
        { selector: 'img[src]', attr: 'src' },
        { selector: 'source[src]', attr: 'src' },
        { selector: 'source[srcset]', attr: 'srcset' },
        { selector: 'img[srcset]', attr: 'srcset' },
        { selector: 'video[src]', attr: 'src' },
        { selector: 'audio[src]', attr: 'src' },
        { selector: 'embed[src]', attr: 'src' },
        { selector: 'object[data]', attr: 'data' }
    ];

    elementsToProcess.forEach(({ selector, attr }) => {
        const elements = doc.querySelectorAll(selector);
        this.log(`Processing ${elements.length} elements with selector: ${selector}`);

        elements.forEach((element) => {
            const originalUrl = element.getAttribute(attr);

            if (originalUrl && this.isInternalResource(originalUrl)) {
                // Only process internal resources
                const newUrl = this.convertToVirtualUrl(originalUrl, indexBasePath, hash);
                if (newUrl) {
                    element.setAttribute(attr, newUrl);
                    this.log(`Converted internal resource: ${originalUrl} -> ${newUrl}`);
                } else {
                    this.log(`Could not convert internal resource: ${originalUrl}`);
                }
            } else if (originalUrl) {
                this.log(`Preserving external resource: ${originalUrl}`);
            }
        });
    });

    // Process navigation links (a elements) - convert internal links but preserve external ones
    const links = doc.querySelectorAll('a[href]');
    this.log(`Processing ${links.length} navigation links`);

    links.forEach((link) => {
        const href = link.getAttribute('href');

        if (href && this.isInternalNavigation(href)) {
            // Convert internal navigation to virtual PeerWeb URLs
            const newHref = this.convertNavigationToVirtualUrl(href, indexBasePath, hash);
            if (newHref) {
                link.setAttribute('href', newHref);
                this.log(`Converted internal navigation: ${href} -> ${newHref}`);
            }
        } else if (href) {
            this.log(`Preserving external link: ${href}`);
        }
    });

    // Process CSS content for @import and url() references
    const styleElements = doc.querySelectorAll('style');
    styleElements.forEach((styleElement) => {
        const cssContent = styleElement.textContent;
        const updatedCss = this.processCssContent(cssContent, indexBasePath, hash);
        styleElement.textContent = updatedCss;
    });

    return doc.documentElement.outerHTML;
}

export function isInternalResource(url) {
    if (!url) {
        return false;
    }

    // External URLs (keep as-is)
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return false;
    }

    // Data URLs (keep as-is)
    if (url.startsWith('data:')) {
        return false;
    }

    // Blob URLs (keep as-is)
    if (url.startsWith('blob:')) {
        return false;
    }

    // Protocol-relative URLs (keep as-is)
    if (url.startsWith('//')) {
        return false;
    }

    // Other protocols (keep as-is)
    if (url.includes(':') && !url.startsWith('./') && !url.startsWith('../')) {
        return false;
    }

    // Everything else is considered internal
    return true;
}

export function convertToVirtualUrl(originalUrl, basePath, hash) {
    // Clean the URL (remove query params and fragments for file matching)
    let cleanUrl = originalUrl.split('?')[0].split('#')[0];

    // Handle relative paths
    if (cleanUrl.startsWith('./')) {
        cleanUrl = cleanUrl.substring(2);
    }

    if (cleanUrl.startsWith('../')) {
        // Handle parent directory references
        cleanUrl = this.resolveParentPath(basePath, cleanUrl);
    } else if (!cleanUrl.startsWith('/')) {
        // Relative to current directory
        cleanUrl = basePath + cleanUrl;
    } else {
        // Absolute path, remove leading slash
        cleanUrl = cleanUrl.substring(1);
    }

    // Create virtual PeerWeb URL
    return `/peerweb-site/${hash}/${cleanUrl}`;
}

export function processCssContent(cssContent, basePath, hash) {
    // Process @import statements
    cssContent = cssContent.replace(/@import\s+['"]([^'"]+)['"]/g, (match, url) => {
        if (this.isInternalResource(url)) {
            const newUrl = this.convertToVirtualUrl(url, basePath, hash);
            return newUrl ? `@import "${newUrl}"` : match;
        }
        return match;
    });

    // Process url() references
    cssContent = cssContent.replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (match, url) => {
        if (this.isInternalResource(url)) {
            const newUrl = this.convertToVirtualUrl(url, basePath, hash);
            return newUrl ? `url("${newUrl}")` : match;
        }
        return match;
    });

    return cssContent;
}

export function resolveParentPath(basePath, relativePath) {
    const baseParts = basePath.split('/').filter(Boolean);
    const relativeParts = relativePath.split('/');

    for (const part of relativeParts) {
        if (part === '..') {
            baseParts.pop();
        } else if (part !== '.') {
            baseParts.push(part);
        }
    }

    return baseParts.join('/');
}

export function sanitizeHtml(html) {
    // Use DOMPurify but preserve all attributes needed for external links
    /** @type {any} */
    const config = {
        ADD_TAGS: ['link', 'style', 'script'],
        ADD_ATTR: ['href', 'src', 'type', 'rel', 'crossorigin', 'integrity', 'target', 'data', 'srcset'],
        ALLOW_UNKNOWN_PROTOCOLS: true, // Preserve compatibility for torrent/web3 linked content
        ALLOWED_URI_REGEXP:
            /^(?:(?:(?:https?|wss?|magnet|ipfs|ipns|blob|data|mailto|tel):)|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
    };
    return DOMPurify.sanitize(html, config);
}
