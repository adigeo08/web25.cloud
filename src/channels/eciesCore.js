// @ts-check
/**
 * Dependency-injected core for the Web25 secp256k1 crypto primitives.
 *
 * The main thread resolves `@noble/*` through the page import map, while the
 * dedicated wallet worker has no import map available and must load the same
 * modules by URL. Both wrap this factory so the algorithms stay in one place.
 *
 * @param {{ secp256k1: any, keccak_256: (data: Uint8Array) => Uint8Array }} deps
 */
export function createEcies({ secp256k1, keccak_256 }) {
    // ─── internal helpers ────────────────────────────────────────────────

    function hexToBytes(hex) {
        const clean = `${hex}`.startsWith('0x') ? hex.slice(2) : hex;
        const arr = new Uint8Array(clean.length / 2);
        for (let i = 0; i < arr.length; i++) {
            arr[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        }
        return arr;
    }

    function bytesToHex(bytes) {
        return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    /** HKDF-SHA256 using WebCrypto — returns `length` derived bytes. */
    async function hkdfSha256(inputKeyMaterial, length = 32) {
        const ikm = inputKeyMaterial instanceof Uint8Array ? inputKeyMaterial : new Uint8Array(inputKeyMaterial);
        const keyMaterial = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new TextEncoder().encode('web25-ecies-salt'),
                info: new TextEncoder().encode('web25-ecies-v1')
            },
            keyMaterial,
            length * 8
        );
        return new Uint8Array(bits);
    }

    /** SHA-256 of arbitrary bytes using WebCrypto. */
    async function sha256(data) {
        return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    }

    // ─── public API ──────────────────────────────────────────────────────

    function getPublicKeyFromPrivateKey(privateKeyHex) {
        return bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKeyHex), false));
    }

    function evmAddressFromPublicKey(publicKeyHex) {
        const pubKeyBytes = hexToBytes(publicKeyHex);
        // Drop the first byte (0x04 uncompressed marker or 0x02/0x03 compressed marker)
        const keyBody = pubKeyBytes.slice(1);
        const hash = keccak_256(keyBody);
        return '0x' + bytesToHex(hash.slice(-20));
    }

    async function eciesEncrypt(plaintext, recipientPublicKeyHex) {
        // 1. Generate ephemeral key pair
        const ephPrivKey = secp256k1.utils.randomPrivateKey();
        const ephPubKey = secp256k1.getPublicKey(ephPrivKey, false); // 65 bytes uncompressed

        // 2. ECDH shared point (compressed 33 bytes)
        const recipPubKeyBytes = hexToBytes(recipientPublicKeyHex);
        const sharedPoint = secp256k1.getSharedSecret(ephPrivKey, recipPubKeyBytes, true);

        // 3. Derive AES-GCM key via HKDF-SHA256
        const encKey = await hkdfSha256(sharedPoint);

        // 4. Encrypt with AES-256-GCM
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const aesKey = await crypto.subtle.importKey('raw', encKey, { name: 'AES-GCM' }, false, ['encrypt']);
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            aesKey,
            new TextEncoder().encode(plaintext)
        );

        // 5. Wire: ephPubKey(65B) || iv(12B) || ciphertext
        return bytesToHex(ephPubKey) + bytesToHex(iv) + bytesToHex(new Uint8Array(ciphertext));
    }

    async function eciesDecrypt(encryptedHex, ownPrivateKeyHex) {
        const EPH_HEX = 65 * 2; // 130 chars
        const IV_HEX = 12 * 2; // 24 chars

        const ephPubKeyBytes = hexToBytes(encryptedHex.slice(0, EPH_HEX));
        const iv = hexToBytes(encryptedHex.slice(EPH_HEX, EPH_HEX + IV_HEX));
        const ciphertext = hexToBytes(encryptedHex.slice(EPH_HEX + IV_HEX));

        const ownPrivKeyBytes = hexToBytes(ownPrivateKeyHex);
        const sharedPoint = secp256k1.getSharedSecret(ownPrivKeyBytes, ephPubKeyBytes, true);

        const encKey = await hkdfSha256(sharedPoint);

        const aesKey = await crypto.subtle.importKey('raw', encKey, { name: 'AES-GCM' }, false, ['decrypt']);
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);

        return new TextDecoder().decode(plaintext);
    }

    async function signMessage(message, privateKeyHex) {
        const msgHash = await sha256(new TextEncoder().encode(message));
        const sig = secp256k1.sign(msgHash, hexToBytes(privateKeyHex), { lowS: true });
        return bytesToHex(sig.toCompactRawBytes());
    }

    async function verifySignature(message, signatureHex, publicKeyHex) {
        try {
            const msgHash = await sha256(new TextEncoder().encode(message));
            const sig = secp256k1.Signature.fromCompact(hexToBytes(signatureHex));
            return secp256k1.verify(sig, msgHash, hexToBytes(publicKeyHex));
        } catch (_) {
            return false;
        }
    }

    /**
     * EIP-191 `personal_sign` over a UTF-8 string, byte-compatible with
     * viem's `account.signMessage({ message })`.
     * @param {string} message
     * @param {string} privateKeyHex
     * @returns {`0x${string}`} 65-byte r||s||v signature (v = 27 + recovery)
     */
    function signEvmMessage(message, privateKeyHex) {
        const messageBytes = new TextEncoder().encode(message);
        const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
        const preimage = new Uint8Array(prefix.length + messageBytes.length);
        preimage.set(prefix, 0);
        preimage.set(messageBytes, prefix.length);

        const digest = keccak_256(preimage);
        const sig = secp256k1.sign(digest, hexToBytes(privateKeyHex), { lowS: true });
        if (typeof sig.recovery !== 'number') {
            throw new Error('Signature is missing the recovery parameter.');
        }
        const compact = sig.toCompactRawBytes();
        const full = new Uint8Array(65);
        full.set(compact, 0);
        full[64] = 27 + sig.recovery;
        return /** @type {`0x${string}`} */ (`0x${bytesToHex(full)}`);
    }

    return {
        hexToBytes,
        bytesToHex,
        getPublicKeyFromPrivateKey,
        evmAddressFromPublicKey,
        eciesEncrypt,
        eciesDecrypt,
        signMessage,
        verifySignature,
        signEvmMessage
    };
}
