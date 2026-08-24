/**
 * Security boundary #1 — the wallet key is derived from WebAuthn PRF output,
 * never from anything that is persisted.
 *
 * The acceptance criterion is checked directly: an attacker who reads every
 * value in localStorage plus the WebAuthn credential metadata still cannot
 * decrypt the wallet blob, because the PRF secret lives only inside the
 * authenticator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, webcrypto } from 'node:crypto';

// ─── minimal browser environment ─────────────────────────────────────────

class MemoryStorage {
    constructor() {
        this.map = new Map();
    }
    getItem(key) {
        return this.map.has(key) ? this.map.get(key) : null;
    }
    setItem(key, value) {
        this.map.set(key, String(value));
    }
    removeItem(key) {
        this.map.delete(key);
    }
    clear() {
        this.map.clear();
    }
    entries() {
        return [...this.map.entries()];
    }
}

class PublicKeyCredential {
    constructor(rawId, extensionResults) {
        this.rawId = rawId;
        this.type = 'public-key';
        this._extensions = extensionResults;
    }
    getClientExtensionResults() {
        return this._extensions;
    }
}

/**
 * A fake authenticator. Its per-credential PRF seed is the only secret in the
 * whole system and is deliberately unreachable from storage.
 */
class FakeAuthenticator {
    constructor({ prfSupported = true, prfAtCreate = false } = {}) {
        this.prfSupported = prfSupported;
        this.prfAtCreate = prfAtCreate;
        this.seeds = new Map();
        this.createCalls = [];
        this.getCalls = [];
        this.counter = 0;
    }

    _prf(credentialId, salt) {
        const seed = this.seeds.get(credentialId);
        if (!seed) throw new Error('unknown credential');
        return new Uint8Array(createHmac('sha256', Buffer.from(seed)).update(Buffer.from(salt)).digest());
    }

    async create(options) {
        const request = options.publicKey;
        this.createCalls.push(request);

        this.counter += 1;
        const rawId = new Uint8Array(16).fill(this.counter);
        const credentialId = Buffer.from(rawId).toString('base64url');

        if (!this.prfSupported) {
            return new PublicKeyCredential(rawId, { prf: { enabled: false } });
        }

        this.seeds.set(credentialId, webcrypto.getRandomValues(new Uint8Array(32)));

        const extensions = { prf: { enabled: true } };
        if (this.prfAtCreate) {
            const salt = new Uint8Array(request.extensions.prf.eval.first);
            extensions.prf.results = { first: this._prf(credentialId, salt).buffer };
        }
        return new PublicKeyCredential(rawId, extensions);
    }

    async get(options) {
        const request = options.publicKey;
        this.getCalls.push(request);

        const allowed = request.allowCredentials?.[0];
        const credentialId = Buffer.from(new Uint8Array(allowed.id)).toString('base64url');

        if (!this.prfSupported || !request.extensions?.prf?.eval?.first) {
            return new PublicKeyCredential(new Uint8Array(allowed.id), { prf: {} });
        }

        const salt = new Uint8Array(request.extensions.prf.eval.first);
        return new PublicKeyCredential(new Uint8Array(allowed.id), {
            prf: { results: { first: this._prf(credentialId, salt).buffer } }
        });
    }
}

const storage = new MemoryStorage();

globalThis.PublicKeyCredential = PublicKeyCredential;
globalThis.window = {
    location: { hostname: 'web25.cloud', origin: 'https://web25.cloud' },
    PublicKeyCredential
};
globalThis.localStorage = storage;
globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');

let authenticator = new FakeAuthenticator();
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        credentials: {
            create: (options) => authenticator.create(options),
            get: (options) => authenticator.get(options)
        }
    }
});

const vault = await import('../src/auth/PasskeyVault.js');

test.beforeEach(() => {
    storage.clear();
    authenticator = new FakeAuthenticator();
});

const SECRET = '0x1111111111111111111111111111111111111111111111111111111111111111';

// ─── user.id carries no key material ─────────────────────────────────────

test('user.id is a fresh random handle and is never read back', async () => {
    const first = await vault.createPasskeyVault({ username: 'a', displayName: 'A', secret: SECRET });
    storage.clear();
    authenticator = new FakeAuthenticator();
    const second = await vault.createPasskeyVault({ username: 'b', displayName: 'B', secret: SECRET });

    assert.notEqual(first.credentialId, undefined);
    assert.notEqual(second.credentialId, undefined);

    const userIds = authenticator.createCalls.map((call) => Buffer.from(call.user.id).toString('hex'));
    assert.equal(userIds[0].length, 64, 'user.id is 32 random bytes');

    // The handle is unrelated to any secret and unrelated across registrations.
    const stored = storage.entries().map(([, value]) => value).join('|');
    assert.ok(!stored.includes(userIds[0]), 'user.id is not persisted as key material');

    // Nothing in the flow ever consults response.userHandle: the only remaining
    // mentions are comments explaining why it is gone.
    const source = await import('node:fs').then((fs) =>
        fs.readFileSync(new URL('../src/auth/PasskeyVault.js', import.meta.url), 'utf8')
    );
    const executableUserHandleLines = source
        .split('\n')
        .filter((line) => line.includes('userHandle'))
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    assert.deepEqual(executableUserHandleLines, [], 'the userHandle fallback is gone');
});

test('registration and unlock both request PRF output', async () => {
    const created = await vault.createPasskeyVault({ username: 'a', displayName: 'A', secret: SECRET });

    assert.ok(authenticator.createCalls[0].extensions.prf.eval.first, 'registration asks for PRF');
    assert.ok(authenticator.getCalls[0].extensions.prf.eval.first, 'wrapping asks for PRF');

    authenticator.getCalls.length = 0;
    await vault.openPasskeyVault(created.credentialId, created.sealedBlob);
    assert.ok(authenticator.getCalls[0].extensions.prf.eval.first, 'unlock asks for PRF');
    assert.equal(authenticator.getCalls[0].userVerification, 'required');
});

// ─── the acceptance criterion ────────────────────────────────────────────

test('persisted state alone cannot decrypt the wallet blob', async () => {
    const created = await vault.createPasskeyVault({ username: 'a', displayName: 'A', secret: SECRET });

    const persisted = storage.entries();
    assert.ok(persisted.length > 0, 'credential metadata is persisted');

    const dump = JSON.stringify(persisted) + created.sealedBlob;
    assert.ok(!dump.includes(SECRET), 'the private key is not stored in the clear');
    assert.ok(!dump.includes(SECRET.slice(2)), 'the private key is not stored in the clear');

    // The record holds only non-secret material: salts and a wrapped key.
    const record = JSON.parse(persisted[0][1]);
    assert.deepEqual(Object.keys(record).sort(), [
        'credentialId',
        'credentialIds',
        'hkdfSalt',
        'prfSalt',
        'v',
        'vaultId',
        'wrapIv',
        'wrappedVaultKey'
    ]);

    // An attacker holding every persisted byte, but not the authenticator's PRF
    // seed, cannot open the vault.
    const attackerAuthenticator = new FakeAuthenticator();
    attackerAuthenticator.seeds.set(created.credentialId, new Uint8Array(32).fill(7));
    authenticator = attackerAuthenticator;

    await assert.rejects(() => vault.openPasskeyVault(created.credentialId, created.sealedBlob), /unwrap/i);
});

test('a correct PRF assertion round-trips the secret', async () => {
    const created = await vault.createPasskeyVault({ username: 'a', displayName: 'A', secret: SECRET });
    assert.equal(await vault.openPasskeyVault(created.credentialId, created.sealedBlob), SECRET);
});

test('the vault also works when the authenticator returns PRF output at registration', async () => {
    authenticator = new FakeAuthenticator({ prfAtCreate: true });
    const created = await vault.createPasskeyVault({ username: 'a', displayName: 'A', secret: SECRET });
    assert.equal(await vault.openPasskeyVault(created.credentialId, created.sealedBlob), SECRET);
});

// ─── PRF is mandatory ────────────────────────────────────────────────────

test('an authenticator without PRF fails registration explicitly and stores nothing', async () => {
    authenticator = new FakeAuthenticator({ prfSupported: false });

    await assert.rejects(
        () => vault.createPasskeyVault({ username: 'a', displayName: 'A', secret: SECRET }),
        (error) => error.code === 'PRF_UNSUPPORTED'
    );
    assert.deepEqual(storage.entries(), [], 'no credential metadata is written without PRF');
});

test('an authenticator that stops returning PRF output fails unlock instead of falling back', async () => {
    const created = await vault.createPasskeyVault({ username: 'a', displayName: 'A', secret: SECRET });

    const degraded = new FakeAuthenticator({ prfSupported: false });
    degraded.seeds = authenticator.seeds;
    authenticator = degraded;

    await assert.rejects(
        () => vault.openPasskeyVault(created.credentialId, created.sealedBlob),
        (error) => error.code === 'PRF_UNSUPPORTED'
    );
});

// ─── multiple passkeys, one wallet ───────────────────────────────────────

test('a second passkey unlocks the same wallet without ever sharing a secret in storage', async () => {
    const created = await vault.createPasskeyVault({ username: 'a', displayName: 'A', secret: SECRET });
    const added = await vault.addPasskeyToVault(created.credentialId);

    assert.notEqual(added.credentialId, created.credentialId);
    assert.equal(await vault.openPasskeyVault(added.credentialId, created.sealedBlob), SECRET);
    assert.equal(await vault.openPasskeyVault(created.credentialId, created.sealedBlob), SECRET);

    // Each credential wraps the shared vault key under its own PRF-derived KEK,
    // so the two wrapped copies must differ.
    const first = JSON.parse(storage.getItem(`web25.passkey.credential.v2.${created.credentialId}`));
    const second = JSON.parse(storage.getItem(`web25.passkey.credential.v2.${added.credentialId}`));
    assert.notEqual(first.wrappedVaultKey, second.wrappedVaultKey);
    assert.notEqual(first.prfSalt, second.prfSalt);
    assert.equal(first.vaultId, second.vaultId);
    assert.deepEqual(first.credentialIds.sort(), second.credentialIds.sort());
});

test('deleting a vault forgets every enrolled credential', async () => {
    const created = await vault.createPasskeyVault({ username: 'a', displayName: 'A', secret: SECRET });
    await vault.addPasskeyToVault(created.credentialId);

    await vault.deletePasskeyVault(created.credentialId);
    assert.deepEqual(storage.entries(), []);
});

// ─── legacy wallets are explicitly incompatible ──────────────────────────

test('pre-PRF wallets are rejected with a recovery-required error, not a weaker unlock', async () => {
    // A v1 blob as written by the userHandle-based vault.
    const legacyBlob = Buffer.from(
        JSON.stringify({ v: 1, ephPK: 'AA==', salt: 'AA==', iv: 'AA==', ct: 'AA==' })
    ).toString('base64');

    assert.equal(vault.isLegacyVaultBlob(legacyBlob), true);
    assert.equal(vault.isLegacyVaultBlob('not-base64-json'), true);

    storage.setItem('web25.passkey.account.legacy-cred', JSON.stringify({ encPK: 'AA==' }));
    assert.equal(vault.hasLegacyCredentialRecord('legacy-cred'), true);

    await assert.rejects(
        () => vault.openPasskeyVault('legacy-cred', legacyBlob),
        (error) => error.code === 'LEGACY_VAULT'
    );

    await assert.rejects(
        () => vault.addPasskeyToVault('legacy-cred'),
        (error) => error.code === 'LEGACY_VAULT'
    );
});

test('a v2 blob from a different vault key does not open', async () => {
    const first = await vault.createPasskeyVault({ username: 'a', displayName: 'A', secret: SECRET });

    storage.clear();
    authenticator = new FakeAuthenticator();
    const second = await vault.createPasskeyVault({ username: 'b', displayName: 'B', secret: '0x22' });

    await assert.rejects(() => vault.openPasskeyVault(second.credentialId, first.sealedBlob));
});
