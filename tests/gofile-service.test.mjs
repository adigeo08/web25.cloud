import test from 'node:test';
import assert from 'node:assert/strict';

import { GoFileError, GoFileService, GOFILE_UPLOAD_ENDPOINT } from '../src/gofile/GoFileService.js';

const reply = (data, options = {}) =>
    new Response(JSON.stringify({ status: 'ok', data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...options
    });

test('first guest upload has no token and captures the issued credential privately', async () => {
    let request;
    const service = new GoFileService({
        fetchImpl: async (url, init) => {
            request = { url, init };
            return reply({
                id: 'file_1',
                parentFolder: 'folder_1',
                parentFolderCode: 'Share123',
                downloadPage: 'https://gofile.io/d/Share123',
                servers: ['store1'],
                guestToken: 'super-secret-token'
            });
        }
    });
    const result = await service.upload(new Blob(['mirror']), { filename: 'mirror.bin' });

    assert.equal(request.url, GOFILE_UPLOAD_ENDPOINT);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.body.get('token'), null);
    assert.equal(request.init.headers.Authorization, undefined);
    assert.equal(result.guestToken, 'super-secret-token');
    assert.equal(result.mirrorLocator, 'folder_1');
    assert.equal(result.publicShareAvailable, true);
    assert.equal(result.programmaticReadVerified, false);
    assert.doesNotMatch(JSON.stringify(result), /super-secret-token/);
    assert.deepEqual(Object.keys(result).includes('guestToken'), false);
});

test('a subsequent upload uses Bearer authentication and the existing guest folder', async () => {
    let request;
    const service = new GoFileService({
        fetchImpl: async (_, init) => {
            request = init;
            return reply({ id: 'file2' });
        }
    });
    await service.upload(new Blob(['mirror']), { token: 'existing-token', folderId: 'existing-folder' });
    assert.equal(request.headers.Authorization, 'Bearer existing-token');
    assert.equal(request.body.get('folderId'), 'existing-folder');
    assert.equal(request.body.get('token'), null, 'the legacy multipart token field is not used');
});

test('AbortSignal is forwarded and cancellation is structured', async () => {
    const controller = new AbortController();
    const service = new GoFileService({
        fetchImpl: async (_, init) => {
            assert.equal(init.signal, controller.signal);
            controller.abort();
            throw new DOMException('cancelled', 'AbortError');
        }
    });
    await assert.rejects(
        () => service.upload(new Blob(['mirror']), { signal: controller.signal }),
        (error) => error instanceof GoFileError && error.code === 'aborted' && !error.message.includes('token')
    );
});

test('HTTP and malformed responses produce safe structured errors', async () => {
    const unauthorized = new GoFileService({ fetchImpl: async () => new Response('secret-response', { status: 401 }) });
    await assert.rejects(
        () => unauthorized.upload(new Blob(['x']), { token: 'do-not-leak' }),
        (error) =>
            error instanceof GoFileError && error.code === 'invalid_token' && !error.message.includes('do-not-leak')
    );

    const malformed = new GoFileService({ fetchImpl: async () => reply({ id: '../unsafe' }) });
    await assert.rejects(
        () => malformed.upload(new Blob(['x'])),
        (error) => error instanceof GoFileError && error.code === 'invalid_response'
    );
});

test('public mirror resolver fetches content metadata before the returned byte URL', async () => {
    const calls = [];
    const service = new GoFileService({
        fetchImpl: async (url) => {
            calls.push(url);
            if (calls.length === 1) {
                return reply({
                    type: 'folder',
                    children: {
                        file1: {
                            type: 'file',
                            name: 'web25-gofile-mirror-v1.json',
                            link: 'https://store1.gofile.io/download/web25-mirror'
                        }
                    }
                });
            }
            return new Response(new Uint8Array([7, 8, 9]));
        }
    });
    assert.deepEqual(await service.downloadPublicMirror('Share123'), new Uint8Array([7, 8, 9]));
    assert.deepEqual(calls, [
        'https://api.gofile.io/contents/Share123',
        'https://store1.gofile.io/download/web25-mirror'
    ]);
});
