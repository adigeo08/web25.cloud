// @ts-check
/**
 * Letter avatars for the messenger.
 *
 * No picture is ever fetched: a profile image is a URL a stranger chose, and
 * loading it would tell them who is looking. So a face is the initials of
 * whatever this browser calls the person, on one of a few fixed tones picked
 * from a stable seed — enough to tell rows apart at a glance, which is most of
 * what a picture does in a chat list.
 */

const TONES = 8;

/**
 * Initials of a name, or one character of an address.
 *
 * An npub or a 0x address is not a name, so its prefix is skipped rather than
 * every unnamed contact reading "N" or "0".
 *
 * @param {string} label
 */
export function avatarInitials(label) {
    const value = `${label || ''}`.trim();
    if (!value) return '?';

    const address = value.match(/^(?:npub1|0x)([0-9a-z])/i);
    if (address) return address[1].toUpperCase();

    const words = value.split(/\s+/).filter(Boolean);
    const picked = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
    // Array.from keeps a character outside the BMP (an emoji) in one piece.
    return picked
        .map((word) => Array.from(word)[0] || '')
        .join('')
        .toUpperCase();
}

/**
 * @param {string} seed
 * @returns {number} 0..TONES-1, the same for the same seed every time
 */
export function avatarTone(seed) {
    let hash = 0;
    for (const char of `${seed || ''}`) hash = (hash * 31 + (char.codePointAt(0) || 0)) >>> 0;
    return hash % TONES;
}

/**
 * Write initials and a tone into an existing avatar element.
 *
 * @param {HTMLElement|null} element
 * @param {string} label
 * @param {string} [seed] defaults to the label
 */
export function paintAvatar(element, label, seed = label) {
    if (!element) return;
    element.textContent = avatarInitials(label);
    element.setAttribute('data-tone', `${avatarTone(seed || label)}`);
}

/**
 * @param {string} label
 * @param {string} [seed]
 * @returns {HTMLElement}
 */
export function createAvatar(label, seed = label) {
    const element = document.createElement('span');
    element.className = 'dm-avatar';
    element.setAttribute('aria-hidden', 'true');
    paintAvatar(element, label, seed);
    return element;
}
