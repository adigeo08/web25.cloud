// @ts-check

const WORD_LIST = [
    'apple', 'river', 'cloud', 'stone', 'forest', 'future', 'planet', 'sunset', 'globe', 'silver', 'light',
    'echo', 'ember', 'ocean', 'rocket', 'bridge', 'pixel', 'orbit', 'matrix', 'violet', 'north', 'delta',
    'alpha', 'lunar', 'sprint', 'cipher', 'sage', 'velvet', 'signal', 'comet', 'harbor', 'zenith'
];

export function generateSeedPhrase(wordCount = 12) {
    const words = [];
    const randomValues = new Uint32Array(wordCount);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < wordCount; i += 1) {
        words.push(WORD_LIST[randomValues[i] % WORD_LIST.length]);
    }
    return words.join(' ');
}
