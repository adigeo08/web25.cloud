// @ts-check

/**
 * Returns true when `sessionId` is a valid Direct Messenger session identifier:
 * a hex-only string between 16 and 64 characters long.
 *
 * @param {unknown} sessionId
 * @returns {boolean}
 */
export function isValidDirectMessageSessionId(sessionId) {
    return /^[a-f0-9]{16,64}$/i.test(`${sessionId || ''}`.trim());
}
