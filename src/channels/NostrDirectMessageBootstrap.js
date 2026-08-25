// @ts-check
/**
 * Nostr transport for the Direct Messenger.
 *
 * Nostr is used for three things and nothing else:
 *
 *   1. addressing — a conversation starts from a recipient `npub`;
 *   2. signalling — the encrypted WebRTC offer/answer exchange;
 *   3. fallback   — an encrypted chat path when WebRTC cannot be established.
 *
 * It never replaces the Web25 message layer. What travels inside a Nostr event
 * is always either a Web25 signed invitation envelope or a Web25
 * signed-and-ECIES-encrypted chat envelope; the relay sees only a NIP-59 gift
 * wrap addressed to a `#p` tag. SDP, ICE candidates, EVM addresses and ECIES
 * keys are never publicly readable.
 *
 * Everything that needs the wallet key (NIP-44 encryption/decryption, the
 * kind-13 seal signature, the Web25 payload signature) is delegated to the
 * dedicated wallet worker through the narrow capability handle in
 * `LocalWalletService.createLocalWalletSigner()`.
 */

import { NOSTR_CONFIG } from '../config/nostr.config.js';
import { nostrCore, nip59 } from '../nostr/nostr.js';
import { normalizeNostrPublicKey } from '../nostr/nip19.js';
import { verifySignature } from './ecies.js';
import {
    createEncryptedDMBootstrapArtifact,
    createSealedDMBootstrapArtifact,
    decryptAndVerifyDMBootstrapArtifact,
    verifySealedDMBootstrapArtifact,
    SEALED_BOOTSTRAP_TYPE,
    BOOTSTRAP_TYPE
} from './DirectMessageBootstrapCore.js';

/** Tag marking a NIP-17 chat rumor as carrying a Web25 ECIES envelope. */
export const WEB25_ENVELOPE_TAG = ['web25', 'ecies-envelope-v1'];

/**
 * Build the gift-wrapped event for one rumor.
 *
 * @param {{ signer: any, recipientNostrPublicKey: string, kind: number, content: string,
 *           senderNostrPublicKey: string, tags?: string[][] }} params
 */
async function giftWrapRumor({ signer, recipientNostrPublicKey, kind, content, senderNostrPublicKey, tags = [] }) {
    const rumor = nip59.buildRumor({
        kind,
        content,
        tags: [['p', recipientNostrPublicKey], ...tags],
        senderPublicKey: senderNostrPublicKey
    });

    const seal = await nip59.createSeal({
        rumor,
        recipientPublicKey: recipientNostrPublicKey,
        nip44Encrypt: (plaintext, peer) => signer.nostrEncrypt(plaintext, peer),
        signEvent: (template) => signer.nostrSignEvent(template)
    });

    return nip59.wrapSeal({ seal, recipientPublicKey: recipientNostrPublicKey });
}

/**
 * Resolve the local Nostr identity, failing loudly when the wallet is locked.
 * @param {any} signer
 */
async function requireLocalNostrIdentity(signer) {
    const identity = await signer.getNostrIdentity();
    if (!identity?.nostrPublicKey) {
        throw new Error('Nostr identity is unavailable: unlock your wallet first.');
    }
    return identity;
}

/**
 * Create the gift-wrapped WebRTC invitation for a recipient addressed by
 * `npub` (or by raw hex public key).
 *
 * When the recipient's full ECIES public key is already known — which is the
 * case for every answer, and for offers where the peer's key was pasted
 * manually — the invitation additionally goes through the existing Web25 ECIES
 * envelope, so the SDP is double-encrypted. When only an `npub` is available,
 * the payload is Web25-signed and its confidentiality comes from the NIP-44
 * gift wrap it never leaves.
 *
 * @param {{
 *   signer: any,
 *   identity: { address: string },
 *   eciesPublicKey: string,
 *   role: 'offer'|'answer',
 *   webrtcDescription: RTCSessionDescriptionInit,
 *   recipient: string,
 *   recipientEciesPublicKey?: string|null,
 *   sessionId?: string|null,
 *   replyToSessionId?: string|null,
 *   ttlMs?: number
 * }} params
 * @returns {Promise<{ event: any, envelope: any, bootstrap: any, recipientNostrPublicKey: string }>}
 */
export async function createNostrDMInvitation({
    signer,
    identity,
    eciesPublicKey,
    role,
    webrtcDescription,
    recipient,
    recipientEciesPublicKey = null,
    sessionId = null,
    replyToSessionId = null,
    ttlMs = NOSTR_CONFIG.INVITATION_TTL_MS
}) {
    const recipientNostrPublicKey = normalizeNostrPublicKey(recipient);
    const local = await requireLocalNostrIdentity(signer);

    let envelope;
    let innerPayload;

    if (recipientEciesPublicKey) {
        ({ envelope, innerPayload } = await createEncryptedDMBootstrapArtifact({
            identity,
            eciesPublicKey,
            role,
            webrtcDescription,
            recipientPublicKey: recipientEciesPublicKey,
            sessionId,
            replyToSessionId,
            ttlMs,
            nostrPublicKey: local.nostrPublicKey
        }));
    } else {
        ({ envelope, innerPayload } = await createSealedDMBootstrapArtifact({
            identity,
            eciesPublicKey,
            nostrPublicKey: local.nostrPublicKey,
            role,
            webrtcDescription,
            recipientNostrPublicKey,
            signFn: (message) => signer.signMessage(message),
            sessionId,
            replyToSessionId,
            ttlMs
        }));
    }

    const event = await giftWrapRumor({
        signer,
        recipientNostrPublicKey,
        senderNostrPublicKey: local.nostrPublicKey,
        kind: NOSTR_CONFIG.WEB25_SIGNALING_KIND,
        content: JSON.stringify(envelope)
    });

    return {
        event,
        envelope,
        recipientNostrPublicKey,
        bootstrap: {
            type: envelope.type,
            version: envelope.version,
            role: envelope.role,
            from: innerPayload.from,
            to: envelope.to,
            webrtc: innerPayload.webrtc,
            session: innerPayload.session
        }
    };
}

/**
 * Wrap an already-encrypted Web25 chat envelope as a NIP-17 chat message.
 * The Web25 ciphertext is the rumor content, so the relay fallback carries the
 * existing signed + ECIES-encrypted message unchanged, with NIP-44/NIP-59 on
 * top of it.
 *
 * @param {{ signer: any, recipient: string, wire: string }} params
 */
export async function createNostrChatEvent({ signer, recipient, wire }) {
    const recipientNostrPublicKey = normalizeNostrPublicKey(recipient);
    const local = await requireLocalNostrIdentity(signer);

    const event = await giftWrapRumor({
        signer,
        recipientNostrPublicKey,
        senderNostrPublicKey: local.nostrPublicKey,
        kind: NOSTR_CONFIG.NIP17_CHAT_KIND,
        content: wire,
        tags: [[...WEB25_ENVELOPE_TAG]]
    });

    return { event, recipientNostrPublicKey };
}

/**
 * Gift-wrap an arbitrary rumor for a recipient.
 *
 * The generic form of the chat/invitation helpers above, used for control
 * messages such as chat requests. Confidentiality and sender authenticity come
 * from the same NIP-44/NIP-59 layers.
 *
 * @param {{ signer: any, recipient: string, kind: number, content: string, tags?: string[][] }} params
 */
export async function createNostrGiftWrappedRumor({ signer, recipient, kind, content, tags = [] }) {
    const recipientNostrPublicKey = normalizeNostrPublicKey(recipient);
    const local = await requireLocalNostrIdentity(signer);

    const event = await giftWrapRumor({
        signer,
        recipientNostrPublicKey,
        senderNostrPublicKey: local.nostrPublicKey,
        kind,
        content,
        tags
    });

    return { event, recipientNostrPublicKey };
}

/**
 * Open the gift wrap and classify what is inside.
 *
 * @param {{ signer: any, giftWrap: any, localNostrPublicKey: string }} params
 * @returns {Promise<{ kind: number, rumor: any, senderNostrPublicKey: string }>}
 */
export async function openNostrGiftWrap({ signer, giftWrap, localNostrPublicKey }) {
    const { rumor, senderPublicKey } = await nip59.unwrap({
        giftWrap,
        localPublicKey: localNostrPublicKey,
        nip44Decrypt: (payload, peer) => signer.nostrDecrypt(payload, peer)
    });
    return { kind: rumor.kind, rumor, senderNostrPublicKey: senderPublicKey };
}

/**
 * Validate a WebRTC invitation that arrived over Nostr.
 *
 * Both envelope shapes end in the same transport-neutral validation: identity
 * binding, TTL, reply-id and one-shot replay protection.
 *
 * @param {{ signer: any, rumor: any, senderNostrPublicKey: string,
 *           localNostrPublicKey: string, localAddress: string,
 *           expectedFrom?: string|null, expectedReplyToSessionId?: string|null }} params
 */
export async function verifyNostrDMInvitation({
    signer,
    rumor,
    senderNostrPublicKey,
    localNostrPublicKey,
    localAddress,
    expectedFrom = null,
    expectedReplyToSessionId = null
}) {
    if (rumor?.kind !== NOSTR_CONFIG.WEB25_SIGNALING_KIND) throw new Error('Event is not a Web25 invitation.');

    let envelope;
    try {
        envelope = JSON.parse(rumor.content);
    } catch (_) {
        throw new Error('Invitation payload is not valid JSON.');
    }

    if (envelope?.type === SEALED_BOOTSTRAP_TYPE) {
        return verifySealedDMBootstrapArtifact({
            envelope,
            senderNostrPublicKey,
            localNostrPublicKey,
            localAddress,
            expectedFrom,
            expectedReplyToSessionId,
            verifyFn: (message, signature, publicKey) => verifySignature(message, signature, publicKey)
        });
    }

    if (envelope?.type === BOOTSTRAP_TYPE) {
        return decryptAndVerifyDMBootstrapArtifact({
            envelope,
            localAddress,
            expectedNostrSender: senderNostrPublicKey,
            decryptFn: (ciphertext) => signer.eciesDecrypt(ciphertext),
            expectedFrom,
            expectedReplyToSessionId
        });
    }

    throw new Error('Invalid bootstrap type.');
}

/**
 * Subscribe to this identity's gift-wrapped inbox across the whole relay pool.
 *
 * Gift wraps carry randomised timestamps up to two days in the past, so the
 * `since` bound is widened accordingly. Everything else — verification,
 * deduplication and filter re-matching — is handled by the pool.
 *
 * @param {{ pool: any, localNostrPublicKey: string, onGiftWrap: (event: any) => void,
 *           sinceSeconds?: number }} params
 */
export function subscribeNostrInbox({ pool, localNostrPublicKey, onGiftWrap, sinceSeconds = undefined }) {
    const since = sinceSeconds ?? Math.floor(Date.now() / 1000) - NOSTR_CONFIG.INBOX_LOOKBACK_SECONDS;
    return pool.subscribe(
        [
            {
                kinds: [nip59.NOSTR_KIND_GIFT_WRAP],
                '#p': [`${localNostrPublicKey}`.toLowerCase()],
                since
            }
        ],
        (event) => onGiftWrap(event)
    );
}

export { nostrCore };
