// @ts-check

export function showSeedPhrase(seedPhrase) {
    const box = document.getElementById('seed-phrase-box');
    const panel = document.getElementById('seed-phrase-screen');
    if (!box || !panel) return;

    box.textContent = seedPhrase;
    panel.classList.remove('hidden');
}

export function hideSeedPhrase() {
    const panel = document.getElementById('seed-phrase-screen');
    if (panel) panel.classList.add('hidden');
}
