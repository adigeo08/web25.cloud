// @ts-check

/** @type {Promise<any> | null} */
let bip39Promise = null;
/** @type {Promise<string[]> | null} */
let englishWordlistPromise = null;

function loadBip39() {
    if (!bip39Promise) {
        bip39Promise = import('https://esm.sh/@scure/bip39@1.3.0');
    }
    return bip39Promise;
}

function loadEnglishWordlist() {
    if (!englishWordlistPromise) {
        englishWordlistPromise = import('https://esm.sh/@scure/bip39@1.3.0/wordlists/english.js').then(
            (m) => m.wordlist
        );
    }
    return englishWordlistPromise;
}

/**
 * Generates a standard BIP-39 12-word mnemonic phrase with 128 bits of entropy.
 * @returns {Promise<string>}
 */
export async function generateBip39Mnemonic() {
    const [{ generateMnemonic }, wordlist] = await Promise.all([loadBip39(), loadEnglishWordlist()]);
    return generateMnemonic(wordlist);
}

/**
 * Converts a BIP-39 mnemonic to a seed buffer (Uint8Array).
 * @param {string} mnemonic
 * @returns {Promise<Uint8Array>}
 */
export async function mnemonicToSeedBytes(mnemonic) {
    const { mnemonicToSeed } = await loadBip39();
    return mnemonicToSeed(mnemonic);
}
