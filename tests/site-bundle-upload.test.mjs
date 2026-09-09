import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';

if (typeof globalThis.DecompressionStream === 'undefined') {
    globalThis.DecompressionStream = class {
        constructor(format) {
            if (format !== 'gzip') throw new Error('Unsupported format');
            const transform = new TransformStream({
                transform(chunk, controller) {
                    controller.enqueue(new Uint8Array(gunzipSync(chunk)));
                }
            });
            this.readable = transform.readable;
            this.writable = transform.writable;
        }
    };
}

const { decodeDroppedSiteBundle } = await import('../src/core/torrent/SiteBundleUpload.js');

function b64(text) {
    return Buffer.from(text).toString('base64');
}

const bundle = {
    schema: 'web25-sitebundle-v1',
    entryPath: 'index.html',
    files: [
        {
            path: 'index.html',
            contentType: 'text/html',
            encoding: 'base64',
            bytesBase64: b64('<link rel="stylesheet" href="styles.css"><main>Hello</main>')
        },
        {
            path: 'styles.css',
            contentType: 'text/css',
            encoding: 'base64',
            bytesBase64: b64('main{font-weight:700}')
        },
        {
            path: 'app.js',
            contentType: 'text/javascript',
            encoding: 'base64',
            bytesBase64: b64('console.log("ok")')
        }
    ]
};

test('plain JSON site bundle expands every file before Preview & Protect', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const decoded = await decodeDroppedSiteBundle({
        name: 'website.json',
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    });

    assert.equal(decoded.entryPath, 'index.html');
    assert.deepEqual(decoded.files.map((file) => file.path).sort(), ['app.js', 'index.html', 'styles.css']);
    assert.equal(new TextDecoder().decode(decoded.files.find((file) => file.path === 'styles.css').bytes), 'main{font-weight:700}');
});

test('gzip JSON site bundle expands every file before Preview & Protect', async () => {
    const compressed = gzipSync(Buffer.from(JSON.stringify(bundle)));
    const decoded = await decodeDroppedSiteBundle({
        name: 'site.bundle.json.gz',
        arrayBuffer: async () => compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength)
    });

    assert.deepEqual(decoded.files.map((file) => file.path).sort(), ['app.js', 'index.html', 'styles.css']);
    assert.equal(decoded.files.find((file) => file.path === 'styles.css').contentType, 'text/css');
});
