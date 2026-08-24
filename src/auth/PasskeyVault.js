// @ts-check
/**
 * Passkey-protected vault built on the WebAuthn PRF extension.
 *
 * Threat model
 * ------------
 * Nothing persisted by this module is sufficient to derive the vault key.
 * The only secret is the PRF output produced by the authenticator during a
 * user-verified assertion; it never leaves this module's call stack and is
 * never written to IndexedDB, localStorage or any other storage.
 *
 * Layout
 * ------
 *   PRF(credential, prfSalt)  --HKDF-SHA256-->  KEK  (AES-GCM, non-extractable)
 *   KEK                       --AES-GCM------>  wraps the 32-byte vault key
 *   vault key                 --HKDF-SHA256-->  CEK  (AES-GCM) encrypts the blob
 *
 * Every passkey enrolled against a vault wraps the *same* vault key under its
 * own PRF-derived KEK, so any of them can open the same wallet.
 *
 * `user.id` is a fresh random, non-secret handle. It carries no key material
 * and `response.userHandle` is never read back.
 */

const CREDENTIAL_STORAGE_PREFIX = 'web25.passkey.credential.v2.';
const LEGACY_ACCOUNT_STORAGE_PREFIX = 'web25.passkey.account.';
const VAULT_BLOB_VERSION = 2;
const PRF_INFO = 'web25.passkeyvault.prf.v2';
const BLOB_INFO = 'web25.passkeyvault.blob.v2';

export class PrfUnsupportedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PrfUnsupportedError';
        this.code = 'PRF_UNSUPPORTED';
    }
}

export class LegacyVaultError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LegacyVaultError';
        this.code = 'LEGACY_VAULT';
    }
}

// ─── encoding helpers ────────────────────────────────────────────────────

function passkeyRpId() {
    return window.location.hostname;
}

function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
}

function b64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}

function unb64(value) {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function b64url(bytes) {
    return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function unb64url(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return unb64(normalized + pad);
}

function toUtf8Bytes(text) {
    return new TextEncoder().encode(text);
}

function fromUtf8Bytes(bytes) {
    return new TextDecoder().decode(bytes);
}

function zero(bytes) {
    if (bytes instanceof Uint8Array) bytes.fill(0);
}

// ─── non-secret credential metadata ──────────────────────────────────────

/**
 * @typedef {{
 *   v: 2,
 *   vaultId: string,
 *   credentialId: string,
 *   prfSalt: string,
 *   hkdfSalt: string,
 *   wrapIv: string,
 *   wrappedVaultKey: string,
 *   credentialIds: string[]
 * }} CredentialRecord
 */

/** @param {string} credentialId @param {CredentialRecord} record */
function storeCredentialRecord(credentialId, record) {
    localStorage.setItem(`${CREDENTIAL_STORAGE_PREFIX}${credentialId}`, JSON.stringify(record));
}

/** @param {string} credentialId @returns {CredentialRecord | null} */
export function readCredentialRecord(credentialId) {
    const raw = localStorage.getItem(`${CREDENTIAL_STORAGE_PREFIX}${credentialId}`);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed?.v === 2 ? parsed : null;
    } catch (_) {
        return null;
    }
}

function removeCredentialRecord(credentialId) {
    localStorage.removeItem(`${CREDENTIAL_STORAGE_PREFIX}${credentialId}`);
    localStorage.removeItem(`${LEGACY_ACCOUNT_STORAGE_PREFIX}${credentialId}`);
}

/**
 * True when a credential id only resolves to the pre-PRF (v1) layout, whose
 * key material lived in the WebAuthn user handle.
 * @param {string} credentialId
 */
export function hasLegacyCredentialRecord(credentialId) {
    if (readCredentialRecord(credentialId)) return false;
    return localStorage.getItem(`${LEGACY_ACCOUNT_STORAGE_PREFIX}${credentialId}`) !== null;
}

// ─── key derivation ──────────────────────────────────────────────────────

/**
 * PRF output → AES-GCM key-encryption key. The PRF secret is consumed here and
 * never returned to a caller.
 * @param {Uint8Array} prfOutput
 * @param {Uint8Array} hkdfSalt
 */
async function deriveKekFromPrf(prfOutput, hkdfSalt) {
    const material = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: toUtf8Bytes(PRF_INFO) },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Vault key → AES-GCM content-encryption key for the wallet blob.
 * @param {Uint8Array} vaultKey
 * @param {Uint8Array} salt
 */
async function deriveContentKey(vaultKey, salt) {
    const material = await crypto.subtle.importKey('raw', vaultKey, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: toUtf8Bytes(BLOB_INFO) },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// ─── WebAuthn plumbing ───────────────────────────────────────────────────

function readCredentialId(rawId) {
    return b64url(new Uint8Array(rawId));
}

/**
 * Register a new passkey. `user.id` is a random, non-secret handle.
 * @param {{ username: string, displayName: string, prfSalt: Uint8Array }} params
 */
async function webauthnCreate({ username, displayName, prfSalt }) {
    const credential = await navigator.credentials.create({
        publicKey: {
            challenge: randomBytes(32),
            rp: { name: 'Web25.Cloud', id: passkeyRpId() },
            user: {
                // Random, non-secret identifier. No key material lives here.
                id: randomBytes(32),
                name: username,
                displayName
            },
            pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 }
            ],
            authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'required'
            },
            timeout: 60000,
            attestation: 'none',
            extensions: { prf: { eval: { first: prfSalt } } }
        }
    });

    if (!(credential instanceof PublicKeyCredential)) {
        throw new Error('Passkey registration failed.');
    }

    const extensions = /** @type {any} */ (credential.getClientExtensionResults());
    if (!extensions?.prf?.enabled) {
        // The credential exists on the authenticator but is unusable to us; we
        // store no metadata for it, so it is inert and the user can delete it.
        throw new PrfUnsupportedError(
            'This browser or security key does not support the WebAuthn PRF extension, which Web25 requires to protect your wallet. Use a passkey provider with PRF support (for example Chrome/Edge with a platform passkey, or a FIDO2 key with hmac-secret).'
        );
    }

    const credentialId = readCredentialId(credential.rawId);
    const inlinePrf = extensions?.prf?.results?.first;
    return {
        credentialId,
        prfOutput: inlinePrf ? new Uint8Array(inlinePrf) : null
    };
}

/**
 * Run a user-verified assertion and return the PRF output for `prfSalt`.
 * @param {string} credentialId
 * @param {Uint8Array} prfSalt
 * @returns {Promise<Uint8Array>}
 */
async function webauthnPrfAssertion(credentialId, prfSalt) {
    const assertion = await navigator.credentials.get({
        publicKey: {
            challenge: randomBytes(32),
            rpId: passkeyRpId(),
            userVerification: 'required',
            allowCredentials: [{ id: unb64url(credentialId), type: 'public-key' }],
            timeout: 60000,
            extensions: { prf: { eval: { first: prfSalt } } }
        }
    });

    if (!(assertion instanceof PublicKeyCredential)) {
        throw new Error('Passkey authentication failed.');
    }

    const extensions = /** @type {any} */ (assertion.getClientExtensionResults());
    const first = extensions?.prf?.results?.first;
    if (!first) {
        throw new PrfUnsupportedError(
            'The authenticator did not return WebAuthn PRF output, so the wallet key cannot be derived. Web25 does not fall back to a weaker unlock path.'
        );
    }

    const output = new Uint8Array(first);
    if (output.length < 32) {
        throw new PrfUnsupportedError('WebAuthn PRF output is too short to derive a wallet key.');
    }
    return output;
}

// ─── vault key wrapping ──────────────────────────────────────────────────

/**
 * @param {Uint8Array} vaultKey
 * @param {string} credentialId
 * @param {Uint8Array} prfSalt
 * @param {Uint8Array | null} prfOutput  pre-fetched PRF output, if available
 */
async function wrapVaultKey(vaultKey, credentialId, prfSalt, prfOutput) {
    const prf = prfOutput || (await webauthnPrfAssertion(credentialId, prfSalt));
    const hkdfSalt = randomBytes(32);
    const wrapIv = randomBytes(12);
    try {
        const kek = await deriveKekFromPrf(prf, hkdfSalt);
        const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, kek, vaultKey);
        return {
            hkdfSalt: b64(hkdfSalt),
            wrapIv: b64(wrapIv),
            wrappedVaultKey: b64(new Uint8Array(wrapped))
        };
    } finally {
        zero(prf);
    }
}

/**
 * @param {CredentialRecord} record
 * @returns {Promise<Uint8Array>} the raw vault key
 */
async function unwrapVaultKey(record) {
    const prf = await webauthnPrfAssertion(record.credentialId, unb64(record.prfSalt));
    try {
        const kek = await deriveKekFromPrf(prf, unb64(record.hkdfSalt));
        const raw = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: unb64(record.wrapIv) },
            kek,
            unb64(record.wrappedVaultKey)
        );
        return new Uint8Array(raw);
    } catch (error) {
        if (error instanceof PrfUnsupportedError) throw error;
        throw new Error(
            'Failed to unwrap the vault key with this passkey. The stored credential metadata may be corrupted.'
        );
    } finally {
        zero(prf);
    }
}

// ─── public API ──────────────────────────────────────────────────────────

export function passkeySupported() {
    return !!window.PublicKeyCredential && !!navigator.credentials && !!crypto?.subtle;
}

/**
 * Create a passkey and a fresh vault, then seal `secret` into it.
 * @param {{ username?: string, displayName?: string, secret: string }} params
 * @returns {Promise<{ credentialId: string, vaultId: string, sealedBlob: string }>}
 */
export async function createPasskeyVault({ username, displayName, secret }) {
    if (!passkeySupported()) {
        throw new Error('WebAuthn passkeys are not supported on this browser/device.');
    }
    if (typeof secret !== 'string' || !secret) {
        throw new Error('A non-empty secret is required to create a vault.');
    }

    const prfSalt = randomBytes(32);
    const { credentialId, prfOutput } = await webauthnCreate({
        username: username || 'web25-user',
        displayName: displayName || 'Web25 Local Wallet',
        prfSalt
    });

    const vaultKey = randomBytes(32);
    try {
        const wrap = await wrapVaultKey(vaultKey, credentialId, prfSalt, prfOutput);
        const vaultId = b64url(randomBytes(16));

        storeCredentialRecord(credentialId, {
            v: 2,
            vaultId,
            credentialId,
            prfSalt: b64(prfSalt),
            ...wrap,
            credentialIds: [credentialId]
        });

        const sealedBlob = await sealWithVaultKey(secret, vaultKey);
        return { credentialId, vaultId, sealedBlob };
    } finally {
        zero(vaultKey);
    }
}

/**
 * Open a sealed blob using any passkey enrolled against the vault.
 * @param {string} credentialId
 * @param {string} sealedBlob
 * @returns {Promise<string>}
 */
export async function openPasskeyVault(credentialId, sealedBlob) {
    const record = readCredentialRecord(credentialId);
    if (!record) {
        if (hasLegacyCredentialRecord(credentialId)) {
            throw new LegacyVaultError(
                'This wallet was protected with the previous passkey format, which is no longer supported. Please recover the wallet from your seed phrase.'
            );
        }
        throw new Error('Passkey vault metadata not found. Please recover from seed phrase.');
    }

    const vaultKey = await unwrapVaultKey(record);
    try {
        return await openWithVaultKey(sealedBlob, vaultKey);
    } finally {
        zero(vaultKey);
    }
}

/**
 * Enrol an additional passkey that can unlock the same vault.
 * @param {string} existingCredentialId
 * @returns {Promise<{ credentialId: string, credentialIds: string[] }>}
 */
export async function addPasskeyToVault(existingCredentialId) {
    const record = readCredentialRecord(existingCredentialId);
    if (!record) {
        if (hasLegacyCredentialRecord(existingCredentialId)) {
            throw new LegacyVaultError(
                'This wallet was protected with the previous passkey format. Recover it from your seed phrase before adding another passkey.'
            );
        }
        throw new Error('Primary passkey vault metadata not found.');
    }

    const vaultKey = await unwrapVaultKey(record);
    try {
        const prfSalt = randomBytes(32);
        const { credentialId, prfOutput } = await webauthnCreate({
            username: 'web25-alternate',
            displayName: 'Web25 Alternate Passkey',
            prfSalt
        });
        const wrap = await wrapVaultKey(vaultKey, credentialId, prfSalt, prfOutput);

        const credentialIds = Array.from(
            new Set([...(record.credentialIds || []), existingCredentialId, credentialId])
        );

        storeCredentialRecord(credentialId, {
            v: 2,
            vaultId: record.vaultId,
            credentialId,
            prfSalt: b64(prfSalt),
            ...wrap,
            credentialIds
        });

        // Every sibling keeps its own wrapped copy of the vault key; only the
        // shared credential-id roster is refreshed.
        for (const id of credentialIds) {
            const sibling = readCredentialRecord(id);
            if (sibling) storeCredentialRecord(id, { ...sibling, credentialIds });
        }

        return { credentialId, credentialIds };
    } finally {
        zero(vaultKey);
    }
}

/**
 * Forget every credential enrolled against the vault reachable from `credentialId`.
 * @param {string} credentialId
 */
export async function deletePasskeyVault(credentialId) {
    const record = readCredentialRecord(credentialId);
    if (!record) {
        removeCredentialRecord(credentialId);
        return;
    }
    for (const id of record.credentialIds?.length ? record.credentialIds : [credentialId]) {
        removeCredentialRecord(id);
    }
}

// ─── blob sealing (vault key based) ──────────────────────────────────────

/**
 * @param {string} plainText
 * @param {Uint8Array} vaultKey
 * @returns {Promise<string>} base64 of the JSON envelope
 */
async function sealWithVaultKey(plainText, vaultKey) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cek = await deriveContentKey(vaultKey, salt);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cek, toUtf8Bytes(plainText));

    return b64(
        toUtf8Bytes(
            JSON.stringify({
                v: VAULT_BLOB_VERSION,
                salt: b64(salt),
                iv: b64(iv),
                ct: b64(new Uint8Array(cipher))
            })
        )
    );
}

/**
 * @param {string} sealedBlobBase64
 * @param {Uint8Array} vaultKey
 * @returns {Promise<string>}
 */
async function openWithVaultKey(sealedBlobBase64, vaultKey) {
    let payload;
    try {
        payload = JSON.parse(fromUtf8Bytes(unb64(sealedBlobBase64)));
    } catch (_) {
        throw new Error('Encrypted wallet blob is malformed.');
    }

    if (payload?.v !== VAULT_BLOB_VERSION) {
        throw new LegacyVaultError(
            'This encrypted wallet uses an unsupported vault format. Please recover the wallet from your seed phrase.'
        );
    }

    const cek = await deriveContentKey(vaultKey, unb64(payload.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(payload.iv) }, cek, unb64(payload.ct));
    return fromUtf8Bytes(new Uint8Array(plain));
}

/**
 * Whether a stored blob predates the PRF vault and therefore cannot be opened.
 * @param {string | null | undefined} sealedBlobBase64
 */
export function isLegacyVaultBlob(sealedBlobBase64) {
    if (!sealedBlobBase64) return false;
    try {
        const payload = JSON.parse(fromUtf8Bytes(unb64(sealedBlobBase64)));
        return payload?.v !== VAULT_BLOB_VERSION;
    } catch (_) {
        return true;
    }
}
