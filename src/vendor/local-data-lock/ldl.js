// @ts-check

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE = new Map();

function ensureCrypto() {
    if (!globalThis.crypto?.subtle) {
        throw new Error('WebCrypto unavailable');
    }
}

function toBase64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}

function fromBase64(base64) {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function getStorageKey(localIdentity) {
    return `web25.ldl.identity.${localIdentity}`;
}

function randomId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function importWrappingKey(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function resolveRawKey({ localIdentity, addNewPasskey }) {
    ensureCrypto();
    const identity = localIdentity || randomId();
    const cacheHit = CACHE.get(identity);
    if (cacheHit && cacheHit.expiresAt > Date.now()) {
        return { localIdentity: identity, rawKey: cacheHit.rawKey };
    }

    let rawKey;
    const stored = localStorage.getItem(getStorageKey(identity));
    if (stored) {
        rawKey = fromBase64(stored);
    } else if (addNewPasskey || !localIdentity) {
        rawKey = crypto.getRandomValues(new Uint8Array(32));
        localStorage.setItem(getStorageKey(identity), toBase64(rawKey));
    } else {
        throw new Error('Passkey identity not found. Please re-register wallet from seed phrase.');
    }

    CACHE.set(identity, { rawKey, expiresAt: Date.now() + CACHE_TTL_MS });
    return { localIdentity: identity, rawKey };
}

export function isPasskeySupported() {
    return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!crypto?.subtle;
}

export async function getLockKey({ localIdentity, addNewPasskey } = {}) {
    const { localIdentity: resolvedIdentity, rawKey } = await resolveRawKey({ localIdentity, addNewPasskey });
    const cryptoKey = await importWrappingKey(rawKey);
    return {
        localIdentity: resolvedIdentity,
        cryptoKey
    };
}

export async function lockData(data, lockKey) {
    ensureCrypto();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, lockKey.cryptoKey, data);
    const payload = {
        iv: toBase64(iv),
        data: toBase64(new Uint8Array(encrypted))
    };
    return new TextEncoder().encode(JSON.stringify(payload));
}

export async function unlockData(encryptedBlobBytes, lockKey) {
    ensureCrypto();
    const payload = JSON.parse(new TextDecoder().decode(encryptedBlobBytes));
    const iv = fromBase64(payload.iv);
    const encrypted = fromBase64(payload.data);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, lockKey.cryptoKey, encrypted);
    return new Uint8Array(plain);
}

export function clearLockKeyCache() {
    CACHE.clear();
}

export async function removeLocalAccount(localIdentity) {
    CACHE.delete(localIdentity);
    localStorage.removeItem(getStorageKey(localIdentity));
}
