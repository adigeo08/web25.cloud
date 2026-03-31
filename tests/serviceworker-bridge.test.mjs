import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeToTransferableArrayBuffer } from '../src/core/serviceworker/TransferUtils.js';

if (!global.window) {
    global.window = { location: { hostname: 'localhost' } };
}

const { sendToServiceWorker } = await import('../src/core/serviceworker/ServiceWorkerBridge.js');

test('normalizeToTransferableArrayBuffer supports ArrayBuffer, typed view with offset, and plain array', () => {
    const ab = new Uint8Array([1, 2, 3]).buffer;
    assert.equal(normalizeToTransferableArrayBuffer(ab).byteLength, 3);

    const full = new Uint8Array([9, 8, 7, 6]);
    const view = new Uint8Array(full.buffer, 1, 2); // [8,7]
    const fromView = normalizeToTransferableArrayBuffer(view);
    assert.deepEqual(Array.from(new Uint8Array(fromView)), [8, 7]);

    const fromArray = normalizeToTransferableArrayBuffer([5, 4, 3]);
    assert.deepEqual(Array.from(new Uint8Array(fromArray)), [5, 4, 3]);
});

test('sendToServiceWorker uses transfer list and resolves on ACK', async () => {
    let listener = null;
    let postArgs = null;

    Object.defineProperty(global, 'navigator', {
        configurable: true,
        value: {
        serviceWorker: {
            controller: {
                postMessage: (msg, transfer) => {
                    postArgs = { msg, transfer };
                    setTimeout(() => {
                        listener?.({ data: { type: 'ACK', ackId: msg.__ackId } });
                    }, 0);
                }
            },
            addEventListener: (_name, cb) => {
                listener = cb;
            },
            removeEventListener: () => {}
        }
        }
    });

    const ok = await sendToServiceWorker.call(
        { log: () => {}, waitForController: async () => {} },
        'RESOURCE_RESPONSE',
        { requestId: 'r1', data: new Uint8Array([1]).buffer },
        [new Uint8Array([1]).buffer],
        { requireAck: true, ackTimeoutMs: 1000 }
    );

    assert.equal(ok, true);
    assert.equal(postArgs.transfer.length, 1);
    assert.equal(postArgs.msg.type, 'RESOURCE_RESPONSE');
});

test('sendToServiceWorker falls back to structured clone when transfer fails', async () => {
    let calls = 0;
    let secondCallTransfer;

    Object.defineProperty(global, 'navigator', {
        configurable: true,
        value: {
        serviceWorker: {
            controller: {
                postMessage: (_msg, transfer) => {
                    calls++;
                    if (calls === 1) {
                        throw new Error('transfer not supported');
                    }
                    secondCallTransfer = transfer;
                }
            },
            addEventListener: () => {},
            removeEventListener: () => {}
        }
        }
    });

    const ok = await sendToServiceWorker.call(
        { log: () => {}, waitForController: async () => {} },
        'SITE_READY',
        { hash: 'abc' },
        [new Uint8Array([1]).buffer]
    );

    assert.equal(ok, true);
    assert.equal(calls, 2);
    assert.equal(secondCallTransfer, undefined);
});
