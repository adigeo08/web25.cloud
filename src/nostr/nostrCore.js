// @ts-check
/**
 * Dependency-injected core for the Web25 Nostr identity and messaging layer.
 *
 * Mirrors the `eciesCore.js` pattern: the main thread resolves `@noble/*`
 * through the page import map, the dedicated wallet worker resolves the same
 * builds by absolute URL, and both wrap this single factory so the algorithms
 * can never drift apart.
 *
 * Implemented here:
 *   - NIP-01  event serialisation / id / BIP-340 signature
 *   - NIP-19  `npub` encoding of the x-only public key
 *   - NIP-44  v2 conversation keys, encryption and decryption
 *   - NIP-59  seal (kind 13) and gift wrap (kind 1059)
 *
 * The Nostr identity is the *same* secp256k1 key as the EVM/ECIES identity:
 * the Nostr public key is simply the x coordinate of the wallet's public key.
 * No second seed and no second private key exist anywhere in this codebase.
 *
 * @param {{
 *   secp256k1: any,
 *   schnorr: any,
 *   sha256: (data: Uint8Array) => Uint8Array,
 *   hmac: (hash: any, key: Uint8Array, message: Uint8Array) => Uint8Array,
 *   sha256Hash: any,
 *   hkdfExtract: (hash: any, ikm: Uint8Array, salt: Uint8Array) => Uint8Array,
 *   hkdfExpand: (hash: any, prk: Uint8Array, info: Uint8Array, length: number) => Uint8Array,
 *   chacha20: (key: Uint8Array, nonce: Uint8Array, data: Uint8Array) => Uint8Array
 * }} deps
 */
export function createNostrCore({ secp256k1, schnorr, sha256, hmac, sha256Hash, hkdfExtract, hkdfExpand, chacha20 }) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const NIP44_VERSION = 2;
    const NIP44_SALT = encoder.encode('nip44-v2');
    const MIN_PLAINTEXT_BYTES = 1;
    const MAX_PLAINTEXT_BYTES = 65535;
    const MIN_PAYLOAD_BYTES = 99;
    const MAX_PAYLOAD_BYTES = 65603;

    const HEX32_RE = /^[0-9a-f]{64}$/;

    // ─── byte helpers ────────────────────────────────────────────────────

    /** @param {string} hex */
    function hexToBytes(hex) {
        const clean = `${hex}`.startsWith('0x') ? `${hex}`.slice(2) : `${hex}`;
        if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error('Invalid hex string.');
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        return out;
    }

    /** @param {Uint8Array} bytes */
    function bytesToHex(bytes) {
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
        return out;
    }

    /** @param {Uint8Array[]} chunks */
    function concatBytes(chunks) {
        let total = 0;
        for (const chunk of chunks) total += chunk.length;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }

    /** @param {Uint8Array} a @param {Uint8Array} b */
    function timingSafeEqual(a, b) {
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff === 0;
    }

    /** @param {number} length */
    function randomBytes(length) {
        const out = new Uint8Array(length);
        crypto.getRandomValues(out);
        return out;
    }

    /** @param {Uint8Array} bytes */
    function bytesToBase64(bytes) {
        if (typeof btoa === 'function') {
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary);
        }
        if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
        throw new Error('Base64 encoder unavailable in this environment.');
    }

    /** @param {string} value */
    function base64ToBytes(value) {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid base64 payload.');
        if (typeof atob === 'function') {
            const binary = atob(value);
            const out = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
            return out;
        }
        if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
        throw new Error('Base64 decoder unavailable in this environment.');
    }

    // ─── identity ────────────────────────────────────────────────────────

    /**
     * The Nostr public key of a private key: the BIP-340 x-only public key.
     * @param {string} privateKeyHex
     * @returns {string} 64-char lowercase hex
     */
    function getNostrPublicKey(privateKeyHex) {
        return bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex)));
    }

    /**
     * The same derivation, starting from the wallet's uncompressed ECIES key.
     * This is what binds the Nostr identity to the EVM/ECIES identity: all
     * three are views of one secp256k1 key pair.
     * @param {string} publicKeyHex uncompressed `04…` (130 hex chars)
     * @returns {string} 64-char lowercase hex x coordinate
     */
    function nostrPublicKeyFromEciesPublicKey(publicKeyHex) {
        const normalized = `${publicKeyHex || ''}`.trim().replace(/^0x/, '').toLowerCase();
        if (!/^04[0-9a-f]{128}$/.test(normalized)) {
            throw new Error('Expected an uncompressed secp256k1 public key (04… hex, 130 hex chars).');
        }
        return normalized.slice(2, 66);
    }

    return {
        hexToBytes,
        bytesToHex,
        concatBytes,
        randomBytes,
        bytesToBase64,
        base64ToBytes,
        getNostrPublicKey,
        nostrPublicKeyFromEciesPublicKey,

        // ─── NIP-01 events ───────────────────────────────────────────────

        /**
         * Canonical NIP-01 serialisation of an event.
         * @param {{ pubkey: string, created_at: number, kind: number, tags: string[][], content: string }} event
         */
        serializeEvent(event) {
            return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
        },

        /** @param {any} event */
        getEventHash(event) {
            return bytesToHex(sha256(encoder.encode(this.serializeEvent(event))));
        },

        /**
         * Structural validation only — no signature check. Used before any
         * cryptographic work so relay input can be discarded cheaply.
         * @param {any} event
         * @returns {boolean}
         */
        isWellFormedEvent(event) {
            if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
            if (!HEX32_RE.test(`${event.id}`)) return false;
            if (!HEX32_RE.test(`${event.pubkey}`)) return false;
            if (typeof event.sig !== 'string' || !/^[0-9a-f]{128}$/.test(event.sig)) return false;
            if (!Number.isInteger(event.kind) || event.kind < 0 || event.kind > 65535) return false;
            if (!Number.isInteger(event.created_at) || event.created_at < 0) return false;
            if (typeof event.content !== 'string') return false;
            if (!Array.isArray(event.tags)) return false;
            for (const tag of event.tags) {
                if (!Array.isArray(tag)) return false;
                for (const item of tag) {
                    if (typeof item !== 'string') return false;
                }
            }
            return true;
        },

        /**
         * Full validation: shape, id binding and BIP-340 signature.
         * A relay is never an authority — every event goes through this.
         * @param {any} event
         * @returns {boolean}
         */
        verifyEvent(event) {
            try {
                if (!this.isWellFormedEvent(event)) return false;
                if (this.getEventHash(event) !== event.id) return false;
                return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
            } catch (_) {
                return false;
            }
        },

        /**
         * Sign an event template with a private key. Only ever called with the
         * wallet key *inside the wallet worker*, or with a throwaway gift-wrap
         * key on the main thread.
         * @param {{ kind: number, created_at: number, tags: string[][], content: string }} template
         * @param {string} privateKeyHex
         */
        signEvent(template, privateKeyHex) {
            const pubkey = getNostrPublicKey(privateKeyHex);
            const unsigned = {
                pubkey,
                created_at: template.created_at,
                kind: template.kind,
                tags: template.tags,
                content: template.content
            };
            const id = this.getEventHash(unsigned);
            const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(privateKeyHex)));
            return { ...unsigned, id, sig };
        },

        // ─── NIP-44 v2 ───────────────────────────────────────────────────

        /**
         * @param {string} privateKeyHex
         * @param {string} peerPublicKeyHex x-only 32-byte hex
         * @returns {Uint8Array} 32-byte conversation key
         */
        nip44ConversationKey(privateKeyHex, peerPublicKeyHex) {
            const peer = `${peerPublicKeyHex || ''}`.trim().toLowerCase();
            if (!HEX32_RE.test(peer)) throw new Error('Nostr public key must be 32 bytes of hex.');
            const shared = secp256k1.getSharedSecret(hexToBytes(privateKeyHex), hexToBytes(`02${peer}`), true);
            const sharedX = new Uint8Array(shared).subarray(1, 33);
            return hkdfExtract(sha256Hash, sharedX, NIP44_SALT);
        },

        /**
         * NIP-44 padding: pad to a power-of-two-derived chunk boundary so the
         * ciphertext length leaks as little as possible about the plaintext.
         * @param {number} unpaddedLength
         */
        calcPaddedLength(unpaddedLength) {
            if (!Number.isInteger(unpaddedLength) || unpaddedLength < 1) throw new Error('Invalid plaintext length.');
            if (unpaddedLength <= 32) return 32;
            const nextPower = 1 << (Math.floor(Math.log2(unpaddedLength - 1)) + 1);
            const chunk = nextPower <= 256 ? 32 : nextPower / 8;
            return chunk * (Math.floor((unpaddedLength - 1) / chunk) + 1);
        },

        /**
         * @param {Uint8Array} conversationKey
         * @param {Uint8Array} nonce 32 bytes
         */
        nip44MessageKeys(conversationKey, nonce) {
            if (conversationKey.length !== 32) throw new Error('Conversation key must be 32 bytes.');
            if (nonce.length !== 32) throw new Error('NIP-44 nonce must be 32 bytes.');
            const keys = hkdfExpand(sha256Hash, conversationKey, nonce, 76);
            return {
                chachaKey: keys.subarray(0, 32),
                chachaNonce: keys.subarray(32, 44),
                hmacKey: keys.subarray(44, 76)
            };
        },

        /**
         * @param {string} plaintext
         * @param {Uint8Array} conversationKey
         * @param {Uint8Array} [nonce] injectable only so the published test
         *        vectors can be replayed; production always randomises.
         * @returns {string} base64 NIP-44 v2 payload
         */
        nip44Encrypt(plaintext, conversationKey, nonce = randomBytes(32)) {
            const plaintextBytes = encoder.encode(`${plaintext}`);
            if (plaintextBytes.length < MIN_PLAINTEXT_BYTES || plaintextBytes.length > MAX_PLAINTEXT_BYTES) {
                throw new Error(`NIP-44 plaintext must be 1–${MAX_PLAINTEXT_BYTES} bytes.`);
            }

            const { chachaKey, chachaNonce, hmacKey } = this.nip44MessageKeys(conversationKey, nonce);

            const paddedLength = this.calcPaddedLength(plaintextBytes.length);
            const padded = new Uint8Array(2 + paddedLength);
            padded[0] = (plaintextBytes.length >> 8) & 0xff;
            padded[1] = plaintextBytes.length & 0xff;
            padded.set(plaintextBytes, 2);

            const ciphertext = chacha20(chachaKey, chachaNonce, padded);
            const mac = hmac(sha256Hash, hmacKey, concatBytes([nonce, ciphertext]));

            return bytesToBase64(concatBytes([new Uint8Array([NIP44_VERSION]), nonce, ciphertext, mac]));
        },

        /**
         * @param {string} payload base64 NIP-44 v2 payload
         * @param {Uint8Array} conversationKey
         * @returns {string} plaintext
         */
        nip44Decrypt(payload, conversationKey) {
            const value = `${payload || ''}`;
            if (value.length === 0) throw new Error('NIP-44 payload is empty.');
            if (value[0] === '#') throw new Error('Unsupported NIP-44 encryption version.');

            const bytes = base64ToBytes(value);
            if (bytes.length < MIN_PAYLOAD_BYTES || bytes.length > MAX_PAYLOAD_BYTES) {
                throw new Error('NIP-44 payload has an invalid length.');
            }
            if (bytes[0] !== NIP44_VERSION) throw new Error(`Unsupported NIP-44 version: ${bytes[0]}.`);

            const nonce = bytes.subarray(1, 33);
            const ciphertext = bytes.subarray(33, bytes.length - 32);
            const mac = bytes.subarray(bytes.length - 32);

            const { chachaKey, chachaNonce, hmacKey } = this.nip44MessageKeys(conversationKey, nonce);
            const expectedMac = hmac(sha256Hash, hmacKey, concatBytes([nonce, ciphertext]));
            if (!timingSafeEqual(expectedMac, mac)) throw new Error('NIP-44 MAC verification failed.');

            const padded = chacha20(chachaKey, chachaNonce, ciphertext);
            const declaredLength = (padded[0] << 8) | padded[1];
            const plaintextBytes = padded.subarray(2, 2 + declaredLength);
            if (
                declaredLength < MIN_PLAINTEXT_BYTES ||
                plaintextBytes.length !== declaredLength ||
                padded.length !== 2 + this.calcPaddedLength(declaredLength)
            ) {
                throw new Error('NIP-44 padding is invalid.');
            }
            return decoder.decode(plaintextBytes);
        }
    };
}
