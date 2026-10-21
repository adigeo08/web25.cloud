// @ts-check
/**
 * The persistent room a one-to-one conversation lives in.
 *
 * A conversation used to be named after the WebRTC session that carried it, so
 * every reconnect was a new room and a message could only be routed while that
 * one session existed. The room is now a property of the two people instead:
 * both Nostr public keys, sorted so neither side's order matters, hashed. Each
 * side derives it alone, and the same pair always gets the same room — after a
 * reload, a reconnect or a week offline.
 *
 * The WebRTC `sessionId` stays what it was, a one-time handle that binds an
 * answer to its offer. It is never the room.
 *
 * A room id is a name, not a credential. Anyone can compute the room for any
 * pair of public keys, so a message that claims one proves nothing: who sent it
 * is decided by the signature and the saved contact's keys, and the room only
 * has to agree with that.
 */

import { sha256 } from '@noble/hashes/sha256';

const HEX32_RE = /^[0-9a-f]{64}$/;

/** Prefix + 32 hex characters: inside the 40 characters a channel name may have. */
const ROOM_PREFIX = 'room-';
const ROOM_HEX_LENGTH = 32;

/** @param {Uint8Array} bytes */
function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {string} key */
function normalizeKey(key) {
    const value = `${key || ''}`.trim().toLowerCase();
    if (!HEX32_RE.test(value)) throw new Error('A conversation room needs two 64-character Nostr public keys.');
    return value;
}

/**
 * The room for a pair of Nostr public keys (x-only hex), in either order.
 *
 * @param {string} localNostrPublicKey
 * @param {string} peerNostrPublicKey
 * @returns {string}
 */
export function conversationRoomId(localNostrPublicKey, peerNostrPublicKey) {
    const [first, second] = [normalizeKey(localNostrPublicKey), normalizeKey(peerNostrPublicKey)].sort();
    const digest = toHex(sha256(new TextEncoder().encode(`web25-room:v1:${first}:${second}`)));
    return `${ROOM_PREFIX}${digest.slice(0, ROOM_HEX_LENGTH)}`;
}

/**
 * Is this the room these two keys share? A comparison, never a lookup: a room
 * id that matches is consistent with the sender, nothing more.
 *
 * @param {string} roomId
 * @param {string} localNostrPublicKey
 * @param {string} peerNostrPublicKey
 */
export function isConversationRoom(roomId, localNostrPublicKey, peerNostrPublicKey) {
    try {
        return `${roomId || ''}` === conversationRoomId(localNostrPublicKey, peerNostrPublicKey);
    } catch (_) {
        return false;
    }
}
