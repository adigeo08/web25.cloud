// @ts-check
/**
 * The bootstrap document loaded into the sandboxed site frame.
 *
 * It runs in an opaque origin (`sandbox` without `allow-same-origin`), so it
 * cannot touch the wallet's IndexedDB, the Web25 localStorage, the signing
 * worker, the service-worker registration or the application DOM. Everything it
 * needs arrives over a single MessagePort whose operations are allowlisted in
 * `SandboxBridgeProtocol.js`.
 *
 * Bundle files are materialised as blob URLs *inside* the sandbox, because an
 * opaque-origin document is not controlled by a service worker and cannot read
 * blob URLs minted by the parent.
 */

const BOOTSTRAP_SCRIPT = String.raw`(function () {
    'use strict';

    var configEl = document.getElementById('web25-sandbox-config');
    var config = JSON.parse(configEl.textContent);
    var TOKEN = config.token;
    var PARENT_ORIGIN = config.parentOrigin;
    var PREFIX = config.prefix;

    var port = null;
    var nextId = 0;
    var pending = new Map();
    var blobUrls = new Map();
    var inflight = new Map();
    var entryDir = '';
    var shimsInstalled = false;

    function call(op, extra) {
        if (!port) return Promise.reject(new Error('Sandbox bridge is not connected.'));
        nextId += 1;
        var id = 's' + nextId;
        var message = { id: id, op: op };
        if (extra) {
            for (var key in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, key)) message[key] = extra[key];
            }
        }
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                pending.delete(id);
                reject(new Error('Sandbox bridge timed out: ' + op));
            }, 30000);
            pending.set(id, { resolve: resolve, reject: reject, timer: timer });
            port.postMessage(message);
        });
    }

    function onPortMessage(event) {
        var data = event.data;
        if (!data || typeof data !== 'object' || typeof data.id !== 'string') return;
        var entry = pending.get(data.id);
        if (!entry) return;
        pending.delete(data.id);
        clearTimeout(entry.timer);
        if (data.ok) entry.resolve(data.result);
        else entry.reject(new Error(data.error || 'Sandbox bridge request failed.'));
    }

    function normalizePath(path) {
        var parts = String(path || '').replace(/^\/+/, '').split('/');
        var stack = [];
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            if (part === '' || part === '.') continue;
            if (part === '..') stack.pop();
            else stack.push(part);
        }
        return stack.join('/');
    }

    function dirOf(path) {
        var idx = String(path || '').lastIndexOf('/');
        return idx === -1 ? '' : path.slice(0, idx + 1);
    }

    /** Map anything the site may reference back to a bundle-relative path. */
    function toBundlePath(reference, baseDir) {
        var raw = String(reference || '');
        if (!raw) return null;
        if (raw.charAt(0) === '#') return null;
        if (/^(?:blob|data|about|javascript|mailto|tel|magnet|ipfs|ipns|ws|wss):/i.test(raw)) return null;

        var withoutQuery = raw.split('#')[0].split('?')[0];
        if (!withoutQuery) return null;

        if (/^https?:\/\//i.test(withoutQuery) || withoutQuery.indexOf('//') === 0) {
            var absolute;
            try {
                absolute = new URL(withoutQuery, PARENT_ORIGIN);
            } catch (_) {
                return null;
            }
            if (absolute.origin !== PARENT_ORIGIN) return null;
            if (absolute.pathname.indexOf(PREFIX) !== 0) return null;
            return normalizePath(absolute.pathname.slice(PREFIX.length));
        }

        if (withoutQuery.charAt(0) === '/') {
            if (withoutQuery.indexOf(PREFIX) === 0) return normalizePath(withoutQuery.slice(PREFIX.length));
            return normalizePath(withoutQuery);
        }

        return normalizePath((baseDir || '') + withoutQuery);
    }

    function isCss(path, type) {
        return /\.css$/i.test(path || '') || String(type || '').indexOf('text/css') === 0;
    }

    function looksLikeDocument(path) {
        var name = String(path || '').split('/').pop() || '';
        if (!name) return true;
        if (name.indexOf('.') === -1) return true;
        return /\.x?html?$/i.test(name);
    }

    function fetchBundleFile(path) {
        return call('resource.get', { path: path }).then(function (result) {
            if (!result || !result.bytes) return null;
            return { bytes: new Uint8Array(result.bytes), type: result.type || 'application/octet-stream' };
        });
    }

    /** Fetch a bundle file over the bridge and expose it as an in-sandbox blob. */
    function materialize(path, depth) {
        var key = normalizePath(path);
        if (!key) return Promise.resolve(null);
        if (blobUrls.has(key)) return Promise.resolve(blobUrls.get(key));
        if (inflight.has(key)) return inflight.get(key);

        var job = fetchBundleFile(key)
            .then(function (file) {
                if (!file) return null;
                if (isCss(key, file.type) && (depth || 0) < 4) {
                    var text = new TextDecoder().decode(file.bytes);
                    return rewriteCss(text, dirOf(key), (depth || 0) + 1).then(function (rewritten) {
                        var cssUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/css' }));
                        blobUrls.set(key, cssUrl);
                        return cssUrl;
                    });
                }
                var blobUrl = URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
                blobUrls.set(key, blobUrl);
                return blobUrl;
            })
            .catch(function () {
                return null;
            })
            .then(function (value) {
                inflight.delete(key);
                return value;
            });

        inflight.set(key, job);
        return job;
    }

    function replaceAsync(text, pattern, replacer) {
        var jobs = [];
        text.replace(pattern, function () {
            jobs.push(replacer.apply(null, Array.prototype.slice.call(arguments)));
            return '';
        });
        return Promise.all(jobs).then(function (values) {
            var index = 0;
            return text.replace(pattern, function () {
                var value = values[index];
                index += 1;
                return value;
            });
        });
    }

    function rewriteCss(cssText, baseDir, depth) {
        return replaceAsync(cssText, /@import\s+(?:url\()?['"]([^'")]+)['"]\)?/g, function (match, reference) {
            var path = toBundlePath(reference, baseDir);
            if (!path) return Promise.resolve(match);
            return materialize(path, depth).then(function (url) {
                return url ? '@import "' + url + '"' : match;
            });
        }).then(function (afterImports) {
            return replaceAsync(afterImports, /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g, function (match, reference) {
                var path = toBundlePath(reference, baseDir);
                if (!path) return Promise.resolve(match);
                return materialize(path, depth).then(function (url) {
                    return url ? 'url("' + url + '")' : match;
                });
            });
        });
    }

    var URL_ATTRIBUTES = [
        ['link[href]', 'href'],
        ['script[src]', 'src'],
        ['img[src]', 'src'],
        ['source[src]', 'src'],
        ['video[src]', 'src'],
        ['video[poster]', 'poster'],
        ['audio[src]', 'src'],
        ['embed[src]', 'src'],
        ['object[data]', 'data'],
        ['iframe[src]', 'src']
    ];

    function rewriteSrcset(value, baseDir) {
        var entries = String(value).split(',');
        return Promise.all(
            entries.map(function (entry) {
                var trimmed = entry.trim();
                if (!trimmed) return Promise.resolve(null);
                var pieces = trimmed.split(/\s+/);
                var path = toBundlePath(pieces[0], baseDir);
                if (!path) return Promise.resolve(trimmed);
                return materialize(path, 0).then(function (url) {
                    if (!url) return trimmed;
                    pieces[0] = url;
                    return pieces.join(' ');
                });
            })
        ).then(function (parts) {
            return parts.filter(Boolean).join(', ');
        });
    }

    function rewriteDocument(doc, baseDir) {
        var jobs = [];

        URL_ATTRIBUTES.forEach(function (pair) {
            Array.prototype.forEach.call(doc.querySelectorAll(pair[0]), function (node) {
                var path = toBundlePath(node.getAttribute(pair[1]), baseDir);
                if (!path) return;
                jobs.push(
                    materialize(path, 0).then(function (url) {
                        if (url) node.setAttribute(pair[1], url);
                    })
                );
            });
        });

        Array.prototype.forEach.call(doc.querySelectorAll('[srcset]'), function (node) {
            jobs.push(
                rewriteSrcset(node.getAttribute('srcset'), baseDir).then(function (value) {
                    if (value) node.setAttribute('srcset', value);
                })
            );
        });

        Array.prototype.forEach.call(doc.querySelectorAll('style'), function (node) {
            jobs.push(
                rewriteCss(node.textContent || '', baseDir, 0).then(function (css) {
                    node.textContent = css;
                })
            );
        });

        // Internal navigation is handled in-sandbox: the frame must never point
        // itself back at a real web25.cloud URL.
        Array.prototype.forEach.call(doc.querySelectorAll('a[href]'), function (node) {
            var href = node.getAttribute('href');
            if (!href || href.charAt(0) === '#') return;
            var path = toBundlePath(href, baseDir);
            if (!path) return;
            if (looksLikeDocument(path)) {
                node.setAttribute('data-web25-href', path);
                node.setAttribute('href', '#');
                return;
            }
            jobs.push(
                materialize(path, 0).then(function (url) {
                    if (url) node.setAttribute('href', url);
                })
            );
        });

        return Promise.all(jobs);
    }

    /**
     * Runtime shims: static references are rewritten above, but scripts may
     * still request bundle files at runtime. Requests that do not resolve to a
     * bundle file are left to the platform, where the sandbox blocks them.
     */
    function installShims() {
        if (shimsInstalled) return;
        shimsInstalled = true;

        var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
        if (nativeFetch) {
            window.fetch = function (input, init) {
                var reference = typeof input === 'string' ? input : input && input.url;
                var path = toBundlePath(reference, entryDir);
                if (!path) return nativeFetch(input, init);
                return materialize(path, 0).then(function (url) {
                    if (!url) return new Response('Not found in torrent bundle', { status: 404 });
                    return nativeFetch(url, init);
                });
            };
        }

        var NativeXhr = window.XMLHttpRequest;
        if (NativeXhr) {
            var nativeOpen = NativeXhr.prototype.open;
            var nativeSend = NativeXhr.prototype.send;
            NativeXhr.prototype.open = function (method, url) {
                this.__web25Path = toBundlePath(url, entryDir);
                this.__web25Args = Array.prototype.slice.call(arguments);
                if (!this.__web25Path) nativeOpen.apply(this, arguments);
            };
            NativeXhr.prototype.send = function (body) {
                var xhr = this;
                if (!xhr.__web25Path) {
                    nativeSend.call(xhr, body);
                    return;
                }
                materialize(xhr.__web25Path, 0).then(function (blobUrl) {
                    var args = xhr.__web25Args.slice();
                    args[1] = blobUrl || 'about:blank';
                    nativeOpen.apply(xhr, args);
                    nativeSend.call(xhr, body);
                });
            };
        }

        // Window-level listener: it survives the document.write below.
        window.addEventListener(
            'click',
            function (event) {
                var node = event.target;
                while (node && node.nodeType === 1 && !node.hasAttribute('data-web25-href')) {
                    node = node.parentNode;
                }
                if (!node || node.nodeType !== 1) return;
                event.preventDefault();
                navigateTo(node.getAttribute('data-web25-href'));
            },
            true
        );
    }

    function writeDocument(html) {
        document.open();
        document.write(html);
        document.close();
    }

    function renderHtml(html, sourcePath) {
        entryDir = dirOf(sourcePath || '');
        var doc = new DOMParser().parseFromString(html || '', 'text/html');
        return rewriteDocument(doc, entryDir).then(function () {
            var title = doc.title || '';
            installShims();
            writeDocument('<!DOCTYPE html>' + doc.documentElement.outerHTML);
            if (title) call('site.title', { title: title }).catch(function () {});
        });
    }

    function navigateTo(path) {
        var target = normalizePath(path);
        if (!target) return;
        fetchBundleFile(target)
            .then(function (file) {
                if (!file) throw new Error('Page not found in torrent bundle: ' + target);
                return renderHtml(new TextDecoder().decode(file.bytes), target);
            })
            .catch(function (error) {
                call('site.log', { message: 'navigation failed: ' + (error && error.message) }).catch(function () {});
            });
    }

    window.addEventListener('message', function (event) {
        if (event.origin !== PARENT_ORIGIN) return;
        var data = event.data;
        if (!data || data.type !== 'WEB25_SANDBOX_INIT' || data.token !== TOKEN) return;
        if (port || !event.ports || !event.ports[0]) return;

        port = event.ports[0];
        port.onmessage = onPortMessage;
        port.start();

        call('sandbox.ready', {})
            .then(function (payload) {
                return renderHtml(payload.entryHtml, payload.entryFile);
            })
            .catch(function (error) {
                writeDocument('<!DOCTYPE html><body style="font:14px system-ui;padding:24px">Failed to render site.</body>');
                call('site.log', { message: 'render failed: ' + (error && error.message) }).catch(function () {});
            });
    });

    window.parent.postMessage({ type: 'WEB25_SANDBOX_HELLO', token: TOKEN }, PARENT_ORIGIN);
})();
`;

/**
 * @param {{ token: string, parentOrigin: string, prefix: string }} config
 * @returns {string} srcdoc for the sandboxed frame
 */
export function buildSandboxBootstrapHtml(config) {
    // Serialised into a JSON script block so no caller-supplied value is ever
    // interpolated into executable source.
    const json = JSON.stringify(config).replace(/</g, '\\u003c');
    return [
        '<!DOCTYPE html>',
        '<html><head><meta charset="utf-8">',
        '<meta name="referrer" content="no-referrer">',
        '<title>Web25 site</title>',
        '<style>html,body{margin:0;padding:0;height:100%;background:#fff;}</style>',
        `<script type="application/json" id="web25-sandbox-config">${json}</${'script'}>`,
        '</head><body>',
        `<${'script'}>${BOOTSTRAP_SCRIPT}</${'script'}>`,
        '</body></html>'
    ].join('');
}
