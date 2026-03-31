import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

global.self = {
    addEventListener: () => {},
    location: { origin: 'http://localhost' },
    clients: { claim: async () => {}, matchAll: async () => [] },
    skipWaiting: () => {}
};

const { parseRangeHeader, createMediaResponse } = require('../peerweb-sw.js');

test('parseRangeHeader parses a valid byte range', () => {
    const range = parseRangeHeader('bytes=10-19', 100);
    assert.deepEqual(range, { start: 10, end: 19 });
});

test('createMediaResponse returns 206 with correct range headers', async () => {
    const bytes = new Uint8Array(100);
    const response = createMediaResponse(bytes, 'video/mp4', { start: 10, end: 19 });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(response.headers.get('Content-Range'), 'bytes 10-19/100');
    assert.equal(response.headers.get('Content-Length'), '10');
    assert.equal(response.headers.get('Content-Type'), 'video/mp4');

    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(body.length, 10);
});

