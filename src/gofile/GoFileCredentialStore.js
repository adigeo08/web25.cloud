// @ts-check

export const GOFILE_CREDENTIAL_DB_NAME = 'web25-gofile-credentials';
export const GOFILE_CREDENTIAL_STORE_NAME = 'encrypted_credentials';
const OWNER_RE = /^[0-9a-f]{64}$/;
const RECORD_ID = 'guest-token';

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(GOFILE_CREDENTIAL_DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(GOFILE_CREDENTIAL_STORE_NAME)) {
                db.createObjectStore(GOFILE_CREDENTIAL_STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** Wallet-worker-protected storage for the one GoFile guest credential. */
export class GoFileCredentialStore {
    /** @param {{ signer: any, now?: () => number }} options */
    constructor({ signer, now = Date.now }) {
        if (!signer) throw new Error('GoFileCredentialStore requires a wallet signing handle.');
        this.signer = signer;
        this.now = now;
    }

    async _owner() {
        const identity = await this.signer.getNostrIdentity();
        const owner = `${identity?.nostrPublicKey || ''}`.trim().toLowerCase();
        if (!OWNER_RE.test(owner)) throw new Error('Unlock your wallet to use the GoFile guest credential.');
        return owner;
    }

    /** @param {{ token: string, folderId?: string|null }|string} credential */
    async write(credential) {
        const owner = await this._owner();
        const token = typeof credential === 'string' ? credential : credential?.token;
        const folderId = typeof credential === 'string' ? null : credential?.folderId || null;
        if (typeof token !== 'string' || token.length < 1 || token.length > 4096) {
            throw new TypeError('GoFile guest token is invalid.');
        }
        if (folderId !== null && (typeof folderId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(folderId))) {
            throw new TypeError('GoFile guest folder id is invalid.');
        }
        const ciphertext = await this.signer.nostrEncrypt(JSON.stringify({ token }), owner);
        const db = await openDb();
        try {
            await requestResult(
                db
                    .transaction(GOFILE_CREDENTIAL_STORE_NAME, 'readwrite')
                    .objectStore(GOFILE_CREDENTIAL_STORE_NAME)
                    .put({ id: RECORD_ID, ciphertext, folderId, updatedAt: this.now() })
            );
        } finally {
            db.close();
        }
    }

    async read() {
        const owner = await this._owner();
        const db = await openDb();
        try {
            const row = await requestResult(
                db
                    .transaction(GOFILE_CREDENTIAL_STORE_NAME, 'readonly')
                    .objectStore(GOFILE_CREDENTIAL_STORE_NAME)
                    .get(RECORD_ID)
            );
            if (!row?.ciphertext) return null;
            const value = JSON.parse(await this.signer.nostrDecrypt(row.ciphertext, owner));
            if (typeof value?.token !== 'string' || value.token.length < 1 || value.token.length > 4096) return null;
            return { token: value.token, folderId: row.folderId || null };
        } finally {
            db.close();
        }
    }

    /** Clear only GoFile state after an explicit invalid-token response. */
    async clearInvalidToken() {
        await this._owner();
        const db = await openDb();
        try {
            await requestResult(
                db
                    .transaction(GOFILE_CREDENTIAL_STORE_NAME, 'readwrite')
                    .objectStore(GOFILE_CREDENTIAL_STORE_NAME)
                    .delete(RECORD_ID)
            );
        } finally {
            db.close();
        }
    }
}
