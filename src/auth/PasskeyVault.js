// @ts-check

const ACCOUNT_STORAGE_PREFIX = 'web25.passkey.account.';
const CACHE_TTL_MS = 30 * 60 * 1000;
/** @type {Map<string, { encSK: Uint8Array, expiresAt: number }>} */
const SESSION_CACHE = new Map();
let curveModulePromise = null;

async function getCurveModule() {
    if (!curveModulePromise) {
        curveModulePromise = import('@noble/curves/ed25519');
    }
    return curveModulePromise;
}

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

function storeAccount(credentialId, account) {
    localStorage.setItem(`${ACCOUNT_STORAGE_PREFIX}${credentialId}`, JSON.stringify(account));
}

function readAccount(credentialId) {
    const raw = localStorage.getItem(`${ACCOUNT_STORAGE_PREFIX}${credentialId}`);
    return raw ? JSON.parse(raw) : null;
}

function cacheEncSK(credentialId, encSK) {
    SESSION_CACHE.set(credentialId, { encSK, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getCachedEncSK(credentialId) {
    const cached = SESSION_CACHE.get(credentialId);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        SESSION_CACHE.delete(credentialId);
        return null;
    }
    return cached.encSK;
}

async function deriveAesKey(sharedSecret, salt) {
    const hkdfMaterial = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt,
            info: toUtf8Bytes('web25.passkeyvault.lock')
        },
        hkdfMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function deriveKeysFromSeed(seed32) {
    const { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub } = await getCurveModule();
    const edPub = ed25519.getPublicKey(seed32);
    const encPK = edwardsToMontgomeryPub(edPub);
    const encSK = edwardsToMontgomeryPriv(seed32);
    return { encPK, encSK };
}

function readCredentialId(rawId) {
    return b64url(new Uint8Array(rawId));
}

async function webauthnCreate(seed, username, displayName) {
    const challenge = randomBytes(32);
    const credential = await navigator.credentials.create({
        publicKey: {
            challenge,
            rp: { name: 'Web25.Cloud', id: passkeyRpId() },
            user: {
                id: seed,
                name: username,
                displayName
            },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'required'
            },
            timeout: 60000,
            attestation: 'none'
        }
    });
    if (!(credential instanceof PublicKeyCredential)) {
        throw new Error('Passkey registration failed.');
    }
    return credential;
}

async function webauthnGet(credentialId) {
    const challenge = randomBytes(32);
    const assertion = await navigator.credentials.get({
        publicKey: {
            challenge,
            rpId: passkeyRpId(),
            userVerification: 'required',
            allowCredentials: [
                {
                    id: unb64url(credentialId),
                    type: 'public-key'
                }
            ],
            timeout: 60000
        }
    });
    if (!(assertion instanceof PublicKeyCredential)) {
        throw new Error('Passkey authentication failed.');
    }

    const response = assertion.response;
    if (!(response instanceof AuthenticatorAssertionResponse)) {
        throw new Error('Invalid passkey assertion response.');
    }

    const userHandle = response.userHandle ? new Uint8Array(response.userHandle) : null;
    return { userHandle };
}

export function passkeySupported() {
    return !!window.PublicKeyCredential && !!navigator.credentials && !!crypto?.subtle;
}

export async function createPasskey({ username, displayName } = {}) {
    if (!passkeySupported()) {
        throw new Error('WebAuthn passkeys are not supported on this browser/device.');
    }

    const seed = randomBytes(32);
    const credential = await webauthnCreate(seed, username || 'web25-user', displayName || 'Web25 Local Wallet');
    const credentialId = readCredentialId(credential.rawId);
    const { encPK, encSK } = await deriveKeysFromSeed(seed);

    storeAccount(credentialId, {
        encPK: b64(encPK),
        credentialIds: [credentialId]
    });
    cacheEncSK(credentialId, encSK);

    return {
        credentialId,
        encPK: b64(encPK),
        encSK
    };
}

export async function unlockPasskey(credentialId) {
    const cached = getCachedEncSK(credentialId);
    if (cached) {
        return { encSK: cached };
    }

    const account = readAccount(credentialId);
    if (!account) {
        throw new Error('Passkey account not found. Please recover from seed phrase.');
    }

    const result = await webauthnGet(credentialId);
    const seed = result.userHandle;
    if (!seed || seed.length !== 32) {
        throw new Error('Please recover your wallet from seed phrase.');
    }

    const { encSK } = await deriveKeysFromSeed(seed);
    cacheEncSK(credentialId, encSK);
    return { encSK };
}

export async function addPasskey(credentialId) {
    const account = readAccount(credentialId);
    if (!account) {
        throw new Error('Primary passkey identity not found.');
    }

    const existing = await webauthnGet(credentialId);
    const seed = existing.userHandle;
    if (!seed || seed.length !== 32) {
        throw new Error('Please recover your wallet from seed phrase.');
    }

    const credential = await webauthnCreate(seed, 'web25-alternate', 'Web25 Alternate Passkey');
    const newCredentialId = readCredentialId(credential.rawId);
    const ids = new Set([...(account.credentialIds || []), newCredentialId]);

    const nextAccount = {
        ...account,
        credentialIds: Array.from(ids)
    };

    for (const id of nextAccount.credentialIds) {
        storeAccount(id, nextAccount);
    }

    return { credentialId: newCredentialId };
}

export async function deletePasskey(credentialId) {
    const account = readAccount(credentialId);
    if (!account) {
        SESSION_CACHE.delete(credentialId);
        localStorage.removeItem(`${ACCOUNT_STORAGE_PREFIX}${credentialId}`);
        return;
    }

    for (const id of account.credentialIds || [credentialId]) {
        SESSION_CACHE.delete(id);
        localStorage.removeItem(`${ACCOUNT_STORAGE_PREFIX}${id}`);
    }
}

export async function sealData(plainText, encPKBase64) {
    const { x25519 } = await getCurveModule();
    const encPK = unb64(encPKBase64);
    const ephSK = randomBytes(32);
    const ephPK = x25519.getPublicKey(ephSK);
    const sharedSecret = x25519.getSharedSecret(ephSK, encPK);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const aesKey = await deriveAesKey(sharedSecret, salt);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, toUtf8Bytes(plainText));

    return b64(
        toUtf8Bytes(
            JSON.stringify({
                v: 1,
                ephPK: b64(ephPK),
                salt: b64(salt),
                iv: b64(iv),
                ct: b64(new Uint8Array(cipher))
            })
        )
    );
}

export async function openData(sealedBlobBase64, encSK) {
    const { x25519 } = await getCurveModule();
    const payload = JSON.parse(fromUtf8Bytes(unb64(sealedBlobBase64)));
    const ephPK = unb64(payload.ephPK);
    const salt = unb64(payload.salt);
    const iv = unb64(payload.iv);
    const ct = unb64(payload.ct);

    const sharedSecret = x25519.getSharedSecret(encSK, ephPK);
    const aesKey = await deriveAesKey(sharedSecret, salt);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
    return fromUtf8Bytes(new Uint8Array(plain));
}

export function clearBiometricSession() {
    SESSION_CACHE.clear();
}
