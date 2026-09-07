import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GoFileError,
    GoFileService,
    GOFILE_UPLOAD_ENDPOINT,
    GOFILE_UPLOAD_TIMEOUT_MS,
    GOFILE_METADATA_TIMEOUT_MS,
    GOFILE_DOWNLOAD_TIMEOUT_MS,
    GOFILE_MIRROR_MAX_BYTES
} from '../src/gofile/GoFileService.js';
import { gofileMirrorFilename } from '../src/gofile/GoFileMirrorCodec.js';

const HASH_ONE = '0123456789abcdef0123456789abcdef01234567';
const HASH_TWO = 'fedcba9876543210fedcba9876543210fedcba98';
const NAME_ONE = gofileMirrorFilename(HASH_ONE);
const NAME_TWO = gofileMirrorFilename(HASH_TWO);

const reply = (data, options = {}) =>
    new Response(JSON.stringify({ status: 'ok', data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...options
    });

const fileNode = (name, link) => ({ type: 'file', name, link });
const streamResponse = (chunks, headers = {}) =>
    new Response(
        new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
            }
        }),
        { headers }
    );

const mirrorMetadata = () =>
    reply({ type: 'folder', children: { a: fileNode(NAME_ONE, 'https://store1.gofile.io/download/one') } });

/**
 * A request that never answers until its deadline aborts it. The keep-alive
 * timer stands in for a real socket: AbortSignal.timeout does not hold the
 * event loop open by itself, so without it the stall would end early for the
 * wrong reason.
 */
const stalled = () => (_url, init) =>
    new Promise((_resolve, reject) => {
        const socket = setTimeout(() => {}, 10000);
        init.signal.addEventListener('abort', () => {
            clearTimeout(socket);
            reject(init.signal.reason);
        });
    });

test('the shipped timeouts are finite and bounded', () => {
    for (const value of [GOFILE_UPLOAD_TIMEOUT_MS, GOFILE_METADATA_TIMEOUT_MS, GOFILE_DOWNLOAD_TIMEOUT_MS]) {
        assert.ok(Number.isFinite(value) && value >= 1000 && value <= 60000, `unusable timeout: ${value}`);
    }
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
    const result = await service.upload(new Blob(['mirror']), { filename: NAME_ONE });

    assert.equal(request.url, GOFILE_UPLOAD_ENDPOINT);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.body.get('token'), null);
    assert.equal(request.init.headers.Authorization, undefined);
    assert.equal(result.guestToken, 'super-secret-token');
    assert.equal(result.publicShareAvailable, true);
    assert.equal(result.programmaticReadVerified, false);
    assert.doesNotMatch(JSON.stringify(result), /super-secret-token/);
    assert.deepEqual(Object.keys(result).includes('guestToken'), false);
});

test('the locator is the uploaded content id, never the folder holding it', async () => {
    const service = new GoFileService({
        fetchImpl: async () =>
            reply({
                id: 'file_1',
                parentFolder: 'shared_guest_folder',
                parentFolderCode: 'Share123',
                downloadPage: 'https://gofile.io/d/Share123'
            })
    });
    const result = await service.upload(new Blob(['mirror']), { filename: NAME_ONE });
    assert.equal(result.mirrorLocator, 'file_1');
    assert.notEqual(result.mirrorLocator, result.parentFolder);
});

test('every mirrored deployment gets its own locator and filename', async () => {
    let counter = 0;
    const service = new GoFileService({
        fetchImpl: async (_url, init) => {
            counter += 1;
            // Same guest account, same folder: only the content id and the
            // filename separate one deployment from the next.
            assert.equal(init.body.get('folderId'), null, 'no upload is ever aimed at a remembered folder');
            return reply({ id: `file_${counter}`, parentFolder: 'shared_guest_folder' });
        }
    });

    const first = await service.upload(new Blob(['one']), { filename: NAME_ONE, token: 'guest' });
    const second = await service.upload(new Blob(['two']), { filename: NAME_TWO, token: 'guest' });

    assert.notEqual(first.mirrorLocator, second.mirrorLocator);
    assert.notEqual(first.filename, second.filename);
    assert.equal(first.filename, NAME_ONE);
    assert.equal(second.filename, NAME_TWO);
});

test('an upload without a deployment-specific filename is refused', async () => {
    const service = new GoFileService({ fetchImpl: async () => reply({ id: 'file_1' }) });
    await assert.rejects(() => service.upload(new Blob(['mirror'])), TypeError);
    await assert.rejects(() => service.upload(new Blob(['mirror']), { filename: 'no slashes/allowed' }), TypeError);
});

test('a subsequent upload authenticates with the stored guest token', async () => {
    let request;
    const service = new GoFileService({
        fetchImpl: async (_, init) => {
            request = init;
            return reply({ id: 'file2' });
        }
    });
    await service.upload(new Blob(['mirror']), { token: 'existing-token', filename: NAME_ONE });
    assert.equal(request.headers.Authorization, 'Bearer existing-token');
    assert.equal(request.body.get('token'), null, 'the legacy multipart token field is not used');
});

test('a stalled upload ends at its deadline instead of hanging', async () => {
    const service = new GoFileService({ fetchImpl: stalled(), uploadTimeoutMs: 25 });
    const started = Date.now();
    await assert.rejects(
        () => service.upload(new Blob(['mirror']), { filename: NAME_ONE }),
        (error) => error instanceof GoFileError && error.code === 'timeout' && /timed out/i.test(error.message)
    );
    assert.ok(Date.now() - started < 5000, 'the upload returned control promptly');
});

test('a stalled metadata lookup and a stalled byte download both end at their deadline', async () => {
    const metadataStall = new GoFileService({ fetchImpl: stalled(), metadataTimeoutMs: 25 });
    await assert.rejects(
        () => metadataStall.downloadPublicMirror('file_1', { expectedFilename: NAME_ONE }),
        (error) => error instanceof GoFileError && error.code === 'timeout'
    );

    let call = 0;
    const downloadStall = new GoFileService({
        fetchImpl: (url, init) => {
            call += 1;
            if (call === 1) return Promise.resolve(reply(fileNode(NAME_ONE, 'https://store1.gofile.io/download/one')));
            return stalled()(url, init);
        },
        downloadTimeoutMs: 25
    });
    await assert.rejects(
        () => downloadStall.downloadPublicMirror('file_1', { expectedFilename: NAME_ONE }),
        (error) => error instanceof GoFileError && error.code === 'timeout'
    );
});

test('caller cancellation stays distinguishable from a deadline', async () => {
    const controller = new AbortController();
    const service = new GoFileService({
        fetchImpl: async (_, init) => {
            controller.abort();
            throw init.signal.reason ?? new DOMException('cancelled', 'AbortError');
        }
    });
    await assert.rejects(
        () => service.upload(new Blob(['mirror']), { filename: NAME_ONE, signal: controller.signal }),
        (error) => error instanceof GoFileError && error.code === 'aborted' && !error.message.includes('token')
    );
});

test('HTTP and malformed responses produce safe structured errors', async () => {
    const unauthorized = new GoFileService({ fetchImpl: async () => new Response('secret-response', { status: 401 }) });
    await assert.rejects(
        () => unauthorized.upload(new Blob(['x']), { token: 'do-not-leak', filename: NAME_ONE }),
        (error) =>
            error instanceof GoFileError && error.code === 'invalid_token' && !error.message.includes('do-not-leak')
    );

    const malformed = new GoFileService({ fetchImpl: async () => reply({ id: '../unsafe' }) });
    await assert.rejects(
        () => malformed.upload(new Blob(['x']), { filename: NAME_ONE }),
        (error) => error instanceof GoFileError && error.code === 'invalid_response'
    );
});

test('the resolver asks for the exact locator it was given, then the byte URL', async () => {
    const calls = [];
    const service = new GoFileService({
        fetchImpl: async (url) => {
            calls.push(url);
            if (calls.length === 1) {
                return reply({
                    type: 'folder',
                    children: { a: fileNode(NAME_ONE, 'https://store1.gofile.io/download/one') }
                });
            }
            return new Response(new Uint8Array([7, 8, 9]));
        }
    });
    assert.deepEqual(
        await service.downloadPublicMirror('file_1', { expectedFilename: NAME_ONE }),
        new Uint8Array([7, 8, 9])
    );
    assert.deepEqual(calls, ['https://api.gofile.io/contents/file_1', 'https://store1.gofile.io/download/one']);
});

test('the resolver rejects an oversized Content-Length before reading bytes', async () => {
    const service = new GoFileService({
        fetchImpl: async (url) =>
            url.startsWith('https://api.gofile.io/')
                ? mirrorMetadata()
                : streamResponse([new Uint8Array([1])], { 'content-length': `${GOFILE_MIRROR_MAX_BYTES + 1}` })
    });
    await assert.rejects(
        () => service.downloadPublicMirror('file_1', { expectedFilename: NAME_ONE }),
        (error) => error instanceof GoFileError && error.code === 'too_large'
    );
});

test('the resolver rejects a missing-length stream once it exceeds the cap', async () => {
    let cancelled = false;
    const service = new GoFileService({
        fetchImpl: async (url) => {
            if (url.startsWith('https://api.gofile.io/')) return mirrorMetadata();
            return {
                ok: true,
                headers: new Headers(),
                body: {
                    getReader() {
                        let index = 0;
                        const chunk = new Uint8Array(1024 * 1024);
                        const count = Math.ceil((GOFILE_MIRROR_MAX_BYTES + 1) / chunk.length);
                        return {
                            async read() {
                                return index === count ? { done: true } : { done: false, value: (index++, chunk) };
                            },
                            async cancel() {
                                cancelled = true;
                            }
                        };
                    }
                }
            };
        }
    });
    await assert.rejects(
        () => service.downloadPublicMirror('file_1', { expectedFilename: NAME_ONE }),
        (error) => error instanceof GoFileError && error.code === 'too_large'
    );
    assert.equal(cancelled, true);
});

test('the resolver accepts a valid under-limit stream', async () => {
    const service = new GoFileService({
        fetchImpl: async (url) =>
            url.startsWith('https://api.gofile.io/')
                ? mirrorMetadata()
                : streamResponse([new Uint8Array([7]), new Uint8Array([8, 9])])
    });
    assert.deepEqual(
        await service.downloadPublicMirror('file_1', { expectedFilename: NAME_ONE }),
        new Uint8Array([7, 8, 9])
    );
});

test('a later deployment cannot shadow or break an earlier one', async () => {
    // Worst case: both deployments end up visible under one locator. Each is
    // still selected by its own deployment-specific name.
    const bothMirrors = {
        type: 'folder',
        children: {
            a: fileNode(NAME_ONE, 'https://store1.gofile.io/download/one'),
            b: fileNode(NAME_TWO, 'https://store1.gofile.io/download/two')
        }
    };
    const served = [];
    const service = new GoFileService({
        fetchImpl: async (url) => {
            if (url.startsWith('https://api.gofile.io/')) return reply(bothMirrors);
            served.push(url);
            return new Response(new Uint8Array([url.endsWith('one') ? 1 : 2]));
        }
    });

    assert.deepEqual(
        await service.downloadPublicMirror('file_1', { expectedFilename: NAME_ONE }),
        new Uint8Array([1]),
        'the first deployment still resolves to its own mirror'
    );
    assert.deepEqual(await service.downloadPublicMirror('file_2', { expectedFilename: NAME_TWO }), new Uint8Array([2]));
    assert.deepEqual(served, ['https://store1.gofile.io/download/one', 'https://store1.gofile.io/download/two']);
});

test('the resolver refuses to guess when the named mirror is absent or duplicated', async () => {
    const missing = new GoFileService({
        fetchImpl: async () => reply({ type: 'folder', children: { b: fileNode(NAME_TWO, 'https://s/two') } })
    });
    await assert.rejects(
        () => missing.downloadPublicMirror('file_1', { expectedFilename: NAME_ONE }),
        (error) => error instanceof GoFileError && error.code === 'mirror_not_found'
    );

    const duplicated = new GoFileService({
        fetchImpl: async () =>
            reply({
                type: 'folder',
                children: { a: fileNode(NAME_ONE, 'https://s/a'), b: fileNode(NAME_ONE, 'https://s/b') }
            })
    });
    await assert.rejects(
        () => duplicated.downloadPublicMirror('file_1', { expectedFilename: NAME_ONE }),
        (error) => error instanceof GoFileError && error.code === 'ambiguous_mirror'
    );

    const ambiguous = new GoFileService({
        fetchImpl: async () =>
            reply({
                type: 'folder',
                children: { a: fileNode(NAME_ONE, 'https://s/a'), b: fileNode(NAME_TWO, 'https://s/b') }
            })
    });
    await assert.rejects(
        () => ambiguous.downloadPublicMirror('file_1'),
        (error) => error instanceof GoFileError && error.code === 'ambiguous_mirror'
    );
});
