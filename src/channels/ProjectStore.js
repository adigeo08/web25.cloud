// @ts-check
import { projectHash } from './ProjectRoom.js';
// A separate encrypted, wallet-scoped IndexedDB record. No plaintext subscriber lists.
export class ProjectStore {
    constructor(signer) {
        this.signer = signer;
        this.queue = Promise.resolve();
    }
    async db() {
        if (!this.opening) {
            this.opening = new Promise((resolve, reject) => {
                const request = indexedDB.open('web25-projects', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'id' });
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }
        return this.opening;
    }
    async request(mode, owner, value = null) {
        const db = await this.db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('records', mode);
            const store = tx.objectStore('records');
            const id = projectHash(`web25-project-store:v1:${owner}`);
            const request = mode === 'readonly' ? store.get(id) : store.put({ id, chunks: value });
            tx.oncomplete = () => resolve(mode === 'readonly' ? request.result?.chunks : request.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Project storage aborted'));
        });
    }
    change(operation) {
        const operationWithIdentity = async () => {
            const { nostrPublicKey: owner } = await this.signer.getNostrIdentity();
            if (!owner) throw new Error('Unlock a Nostr identity first');
            const ciphertext = await this.request('readonly', owner);
            const plaintext = ciphertext
                ? (
                      await Promise.all(
                          (Array.isArray(ciphertext) ? ciphertext : [ciphertext]).map((chunk) =>
                              this.signer.nostrDecrypt(chunk, owner)
                          )
                      )
                  ).join('')
                : null;
            const state = plaintext ? JSON.parse(plaintext) : { owned: {}, followed: {} };
            const result = await operation(state, owner);
            const serialized = JSON.stringify(state);
            if (serialized === plaintext) return result;
            const points = Array.from(serialized);
            const chunks = [];
            for (let i = 0; i < points.length; i += 8000) chunks.push(points.slice(i, i + 8000).join(''));
            await this.request(
                'readwrite',
                owner,
                await Promise.all(chunks.map((chunk) => this.signer.nostrEncrypt(chunk, owner)))
            );
            return result;
        };
        const work = this.queue.then(() =>
            globalThis.navigator?.locks
                ? navigator.locks.request('web25-project-store', operationWithIdentity)
                : operationWithIdentity()
        );
        this.queue = work.catch(() => {});
        return work;
    }
}
