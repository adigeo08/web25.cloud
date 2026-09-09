import test from 'node:test';
import assert from 'node:assert/strict';

import {
    formatMirrorLocator,
    parseMirrorLocator,
    GoFileError,
    GoFileService,
    GOFILE_ACCOUNTS_ENDPOINT,
    GOFILE_STORAGE_URL,
    GOFILE_UPLOAD_ENDPOINT,
    GOFILE_UPLOAD_TIMEOUT_MS,
    GOFILE_DOWNLOAD_TIMEOUT_MS,
    GOFILE_ACCOUNT_TIMEOUT_MS
} from '../src/gofile/GoFileService.js';
import { gofileMirrorFilename } from '../src/gofile/GoFileMirrorCodec.js';

const HASH_ONE = '0123456789abcdef0123456789abcdef01234567';
const HASH_TWO = 'fedcba9876543210fedcba9876543210fedcba98';
const NAME_ONE = gofileMirrorFilename(HASH_ONE);
const NAME_TWO = gofileMirrorFilename(HASH_TWO);
const UUID_ONE = '9632c967-30e5-4123-856a-8b2c425d1c74';
const UUID_TWO = '9ed4fb4e-2f24-44f1-8e40-03e949a36517';

const reply = (data, options = {}) =>
    new Response(JSON.stringify({ status: 'ok', data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...options
    });

const errorReply = (status, httpStatus = 200) =>
    new Response(JSON.stringify({ status }), {
        status: httpStatus,
        headers: { 'content-type': 'application/json' }
    });

/**
 * A request that never answers until its deadline aborts it. The keep-alive
 * timer stands in for a real socket: AbortSignal.timeout does not hold the
 * event loop open by itself.
 */
const stalled = () => (_url, init) =>
    new Promise((_resolve, reject) => {
        const socket = setTimeout(() => {}, 10000);
        init.signal.addEventListener('abort', () => {
            clearTimeout(socket);
            reject(init.signal.reason);
        });
    });

// ── Locators ────────────────────────────────────────────────────────────────

test('a locator names a storage server and a content UUID', () => {
    assert.equal(formatMirrorLocator('store6', UUID_ONE), `store6~${UUID_ONE}`);
    assert.deepEqual(parseMirrorLocator(`store6~${UUID_ONE}`), { server: 'store6', contentId: UUID_ONE });
    // Server names carry hyphens too, so the separator has to be its own thing.
    assert.deepEqual(parseMirrorLocator(`store-1~${UUID_ONE}`), { server: 'store-1', contentId: UUID_ONE });
    assert.deepEqual(parseMirrorLocator(`store6~${UUID_ONE.toUpperCase()}`), {
        server: 'store6',
        contentId: UUID_ONE
    });
});

test('a locator that names no server is refused rather than guessed at', () => {
    // Bare UUIDs are what earlier builds published, back when the read went
    // through the listing API. They cannot address a storage server.
    for (const locator of [UUID_ONE, '', 'store6', 'store6~not-a-uuid', `a~b~${UUID_ONE}`, `sto re~${UUID_ONE}`]) {
        assert.throws(
            () => parseMirrorLocator(locator),
            (error) => error instanceof GoFileError && error.code === 'invalid_locator'
        );
    }
});

test('the shipped timeouts are finite and bounded', () => {
    for (const value of [GOFILE_UPLOAD_TIMEOUT_MS, GOFILE_DOWNLOAD_TIMEOUT_MS, GOFILE_ACCOUNT_TIMEOUT_MS]) {
        assert.ok(Number.isFinite(value) && value >= 1000 && value <= 60000, `unusable timeout: ${value}`);
    }
});

// ── Accounts ────────────────────────────────────────────────────────────────

test('a guest account is created unauthenticated, and its token stays out of projections', async () => {
    let request;
    const service = new GoFileService({
        fetchImpl: async (url, init) => {
            request = { url, method: init?.method, authorization: init?.headers?.Authorization ?? null };
            return reply({
                id: UUID_TWO,
                rootFolder: '86002706-7aa3-4143-a523-1660f089ba4a',
                tier: 'guest',
                token: 'eyJhbGciOiJIUzI1NiJ9.payload.signature'
            });
        }
    });

    const account = await service.createGuestAccount();

    assert.equal(request.url, GOFILE_ACCOUNTS_ENDPOINT);
    assert.equal(request.method, 'POST');
    assert.equal(request.authorization, null, 'minting a credential needs no credential');
    assert.equal(account.token, 'eyJhbGciOiJIUzI1NiJ9.payload.signature');
    assert.equal(account.tier, 'guest');
    assert.doesNotMatch(JSON.stringify(account), /eyJhbGciOiJIUzI1NiJ9/);
});

test('an account response without a usable token is refused', async () => {
    for (const data of [{ id: 'x' }, { token: '' }, { token: 'has spaces in it' }, { token: 123 }]) {
        const service = new GoFileService({ fetchImpl: async () => reply(data) });
        await assert.rejects(
            () => service.createGuestAccount(),
            (error) => error instanceof GoFileError && error.code === 'invalid_response'
        );
    }
});

test('a stalled account request ends at its deadline', async () => {
    const service = new GoFileService({ fetchImpl: stalled() });
    await assert.rejects(
        () => service.createGuestAccount({ timeoutMs: 25 }),
        (error) => error instanceof GoFileError && error.code === 'timeout'
    );
});

// ── Uploads ─────────────────────────────────────────────────────────────────

test('first guest upload has no token and captures the issued credential privately', async () => {
    let request;
    const service = new GoFileService({
        fetchImpl: async (url, init) => {
            request = { url, init };
            return reply({
                id: UUID_ONE,
                parentFolder: '86002706-7aa3-4143-a523-1660f089ba4a',
                parentFolderCode: 'vznxYrkN',
                downloadPage: 'https://gofile.io/d/vznxYrkN',
                servers: ['store6'],
                guestToken: 'super-secret-token'
            });
        }
    });
    const result = await service.upload(new Blob(['mirror']), { filename: NAME_ONE });

    assert.equal(request.url, GOFILE_UPLOAD_ENDPOINT);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.body.get('folderId'), null, 'no upload is aimed at a remembered folder');
    assert.equal(request.init.headers.Authorization, undefined);
    assert.equal(result.guestToken, 'super-secret-token');
    assert.doesNotMatch(JSON.stringify(result), /super-secret-token/);
});

test('the locator names the storage server and the file, never the folder', async () => {
    const service = new GoFileService({
        fetchImpl: async () =>
            reply({
                id: UUID_ONE,
                parentFolder: 'shared_guest_folder',
                parentFolderCode: 'vznxYrkN',
                servers: ['store6']
            })
    });
    const result = await service.upload(new Blob(['mirror']), { filename: NAME_ONE });
    assert.equal(result.mirrorLocator, `store6~${UUID_ONE}`);
    assert.notEqual(result.mirrorLocator, result.parentFolder);
});

test('an upload GoFile stores on no named server yields no locator', async () => {
    const service = new GoFileService({ fetchImpl: async () => reply({ id: UUID_ONE, servers: [] }) });
    const result = await service.upload(new Blob(['mirror']), { filename: NAME_ONE });
    assert.equal(result.mirrorLocator, null, 'a mirror nobody can address is not advertised');
});

test('every mirrored deployment gets its own locator and filename', async () => {
    const ids = [UUID_ONE, UUID_TWO];
    let call = 0;
    const service = new GoFileService({
        fetchImpl: async () => reply({ id: ids[call++], servers: ['store6'] })
    });

    const first = await service.upload(new Blob(['one']), { filename: NAME_ONE, token: 'guest' });
    const second = await service.upload(new Blob(['two']), { filename: NAME_TWO, token: 'guest' });

    assert.notEqual(first.mirrorLocator, second.mirrorLocator);
    assert.notEqual(first.filename, second.filename);
});

test('an upload without a deployment-specific filename is refused', async () => {
    const service = new GoFileService({ fetchImpl: async () => reply({ id: UUID_ONE, servers: ['store6'] }) });
    await assert.rejects(() => service.upload(new Blob(['mirror'])), TypeError);
    await assert.rejects(() => service.upload(new Blob(['mirror']), { filename: 'no slashes/allowed' }), TypeError);
});

test('a subsequent upload authenticates with the stored guest token', async () => {
    let request;
    const service = new GoFileService({
        fetchImpl: async (_, init) => {
            request = init;
            return reply({ id: UUID_ONE, servers: ['store6'] });
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

test('upload failures are classified by the API status, not the HTTP code', async () => {
    // GoFile's own guidance: branch on status, since error-token and
    // error-notPremium are both 401 and mean completely different things.
    const cases = [
        ['error-notPremium', 401, 'premium_required', /Premium-only/i],
        ['error-token', 401, 'invalid_token', /rejected the credential/i],
        ['error-rateLimit', 429, 'rate_limited', /rate limited/i],
        ['error-limits', 403, 'api', /error-limits/]
    ];
    for (const [status, httpStatus, code, message] of cases) {
        const service = new GoFileService({ fetchImpl: async () => errorReply(status, httpStatus) });
        await assert.rejects(
            () => service.upload(new Blob(['x']), { filename: NAME_ONE, token: 'do-not-leak' }),
            (error) => {
                assert.equal(error.code, code, `${status} should map to ${code}`);
                assert.match(error.message, message);
                assert.doesNotMatch(error.message, /do-not-leak/);
                return true;
            }
        );
    }
});

test('a malformed upload response is refused', async () => {
    const malformed = new GoFileService({ fetchImpl: async () => reply({ id: '../unsafe', servers: ['store6'] }) });
    await assert.rejects(
        () => malformed.upload(new Blob(['x']), { filename: NAME_ONE }),
        (error) => error instanceof GoFileError && error.code === 'invalid_response'
    );
});

test('the global fetch is never invoked as a method of the service', async () => {
    // A browser refuses `someObject.fetch(...)` with "Illegal invocation" and
    // refuses it before the request leaves, so the symptom is an empty network
    // tab, not a failed call. Node's fetch ignores its receiver.
    const previous = globalThis.fetch;
    let receiver = 'never called';
    globalThis.fetch = function (...args) {
        receiver = this === undefined || this === globalThis ? 'global' : 'not the global';
        if (receiver !== 'global') {
            throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
        }
        return Promise.resolve(reply({ id: UUID_ONE, servers: ['store6'] }));
    };
    try {
        const service = new GoFileService();
        const result = await service.upload(new Blob(['mirror']), { filename: NAME_ONE });
        assert.equal(receiver, 'global');
        assert.equal(result.mirrorLocator, `store6~${UUID_ONE}`);
    } finally {
        globalThis.fetch = previous;
    }
});

// ── Reading a mirror back ───────────────────────────────────────────────────

test('a mirror is fetched straight from its storage server, with no credential', async () => {
    const seen = [];
    const service = new GoFileService({
        fetchImpl: async (url, init) => {
            seen.push({ url, authorization: init?.headers?.Authorization ?? null });
            return new Response(new Uint8Array([7, 8, 9]));
        }
    });

    const bytes = await service.downloadPublicMirror(`store6~${UUID_ONE}`, { expectedFilename: NAME_ONE });

    assert.deepEqual(bytes, new Uint8Array([7, 8, 9]));
    assert.equal(seen.length, 1, 'one request: no lookup step to authenticate');
    assert.equal(seen[0].url, `https://store6.gofile.io/download/web/${UUID_ONE}/${NAME_ONE}`);
    assert.equal(seen[0].url, GOFILE_STORAGE_URL('store6', UUID_ONE, NAME_ONE));
    assert.equal(seen[0].authorization, null, 'the storage host is never handed an account credential');
});

test('a later deployment cannot shadow or break an earlier one', async () => {
    // Two deployments differ in both halves of the address, so one can never
    // resolve to the other's bytes.
    const served = [];
    const service = new GoFileService({
        fetchImpl: async (url) => {
            served.push(url);
            return new Response(new Uint8Array([url.includes(NAME_ONE) ? 1 : 2]));
        }
    });

    assert.deepEqual(
        await service.downloadPublicMirror(`store6~${UUID_ONE}`, { expectedFilename: NAME_ONE }),
        new Uint8Array([1])
    );
    assert.deepEqual(
        await service.downloadPublicMirror(`store6~${UUID_TWO}`, { expectedFilename: NAME_TWO }),
        new Uint8Array([2])
    );
    assert.notEqual(served[0], served[1]);
});

test('a mirror missing from its server is reported as missing, not as a transport fault', async () => {
    const service = new GoFileService({ fetchImpl: async () => new Response('not found', { status: 404 }) });
    await assert.rejects(
        () => service.downloadPublicMirror(`store6~${UUID_ONE}`, { expectedFilename: NAME_ONE }),
        (error) => error.code === 'mirror_not_found'
    );
});

test('a read without a deployment-specific filename is refused before any request', async () => {
    let called = 0;
    const service = new GoFileService({
        fetchImpl: async () => {
            called += 1;
            return new Response(new Uint8Array([1]));
        }
    });
    for (const filename of [undefined, null, '', 'no slashes/allowed']) {
        await assert.rejects(
            () => service.downloadPublicMirror(`store6~${UUID_ONE}`, { expectedFilename: filename }),
            (error) => error.code === 'invalid_request'
        );
    }
    assert.equal(called, 0);
});

test('a stalled mirror download ends at its deadline', async () => {
    const service = new GoFileService({ fetchImpl: stalled(), downloadTimeoutMs: 25 });
    await assert.rejects(
        () => service.downloadPublicMirror(`store6~${UUID_ONE}`, { expectedFilename: NAME_ONE }),
        (error) => error instanceof GoFileError && error.code === 'timeout'
    );
});

test('the resolver rejects an oversized Content-Length before reading bytes', async () => {
    const service = new GoFileService({
        fetchImpl: async () =>
            new Response(new Uint8Array([1]), { headers: { 'content-length': `${64 * 1024 * 1024 + 1}` } })
    });
    await assert.rejects(
        () => service.downloadPublicMirror(`store6~${UUID_ONE}`, { expectedFilename: NAME_ONE }),
        (error) => error.code === 'too_large'
    );
});

test('the resolver rejects a stream that exceeds the cap while arriving', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const service = new GoFileService({
        fetchImpl: async () =>
            new Response(
                new ReadableStream({
                    pull(controller) {
                        controller.enqueue(chunk.slice());
                    }
                })
            )
    });
    await assert.rejects(
        () => service.downloadPublicMirror(`store6~${UUID_ONE}`, { expectedFilename: NAME_ONE }),
        (error) => error.code === 'too_large'
    );
});

test('a legacy bare-UUID locator is refused with a locator error', async () => {
    let called = 0;
    const service = new GoFileService({
        fetchImpl: async () => {
            called += 1;
            return new Response(new Uint8Array([1]));
        }
    });
    await assert.rejects(
        () => service.downloadPublicMirror(UUID_ONE, { expectedFilename: NAME_ONE }),
        (error) => error.code === 'invalid_locator'
    );
    assert.equal(called, 0);
});
