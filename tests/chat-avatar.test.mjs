/**
 * Letter avatars in the messenger.
 *
 * Nobody's picture is fetched, so a face is initials on a tone. These pin the
 * two things that make that work as a face: the letters read as the person's
 * name rather than as an address prefix, and the same seed always gets the
 * same tone, so one person looks the same in the list, the header and an
 * invitation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { avatarInitials, avatarTone } from '../src/ui/channels/Avatar.js';

test('a two-word name gives first and last initials', () => {
    assert.equal(avatarInitials('Alice Popescu'), 'AP');
    assert.equal(avatarInitials('  ana maria  ionescu '), 'AI');
    assert.equal(avatarInitials('Bogdan'), 'B');
});

test('an address skips its prefix instead of every unnamed contact reading "N"', () => {
    assert.equal(avatarInitials('npub1carol…00000z'), 'C');
    assert.equal(avatarInitials('0xabcdef…'), 'A');
});

test('an emoji stays in one piece, and nothing at all is a question mark', () => {
    assert.equal(avatarInitials('🦊 Fox'), '🦊F');
    assert.equal(avatarInitials(''), '?');
    assert.equal(avatarInitials(undefined), '?');
});

test('the tone is stable for a seed and stays within the palette', () => {
    assert.equal(avatarTone('Alice Popescu'), avatarTone('Alice Popescu'));
    for (const seed of ['', 'a', 'Alice', 'npub1xyz', '0x1234', '🦊']) {
        const tone = avatarTone(seed);
        assert.ok(Number.isInteger(tone) && tone >= 0 && tone < 8, `${seed} → ${tone}`);
    }
});
