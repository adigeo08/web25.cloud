// @ts-check
/**
 * NIP-59 gift wrapping on top of the NIP-44 primitives in `nostrCore.js`.
 *
 * Layering, from the inside out:
 *
 *   rumor      unsigned event — the actual Web25 payload (kind 14 chat message
 *              or the Web25 DM signalling kind). Never leaves this device
 *              unencrypted.
 *   seal       kind 13, signed by the *wallet* key, content = NIP-44(rumor).
 *              Both the encryption and the signature happen inside the wallet
 *              worker; this module only assembles the templates.
 *   gift wrap  kind 1059, signed by a throwaway key generated per message,
 *              content = NIP-44(seal). Only the `#p` tag is public, so relays
 *              learn a recipient and nothing else — no sender, no kind, no
 *              SDP, no ICE candidates, no EVM address, no ECIES key.
 */

export const NOSTR_KIND_SEAL = 13;
export const NOSTR_KIND_GIFT_WRAP = 1059;

/** NIP-59 recommends jittering timestamps up to two days into the past. */
const MAX_TIMESTAMP_JITTER_SECONDS = 2 * 24 * 60 * 60;

/**
 * @param {ReturnType<import('./nostrCore.js').createNostrCore>} core
 */
export function createNip59(core) {
    /**
     * @param {number} nowSeconds
     * @returns {number}
     */
    function jitteredTimestamp(nowSeconds) {
        const jitter = core.randomBytes(4);
        const value = ((jitter[0] << 24) | (jitter[1] << 16) | (jitter[2] << 8) | jitter[3]) >>> 0;
        return nowSeconds - (value % MAX_TIMESTAMP_JITTER_SECONDS);
    }

    return {
        NOSTR_KIND_SEAL,
        NOSTR_KIND_GIFT_WRAP,

        /**
         * Build the unsigned inner event. A rumor has an `id` but no `sig`;
         * its authenticity comes from the seal that carries it.
         * @param {{ kind: number, content: string, tags?: string[][], createdAt?: number, senderPublicKey: string }} params
         */
        buildRumor({ kind, content, tags = [], createdAt = Math.floor(Date.now() / 1000), senderPublicKey }) {
            const rumor = {
                pubkey: `${senderPublicKey}`.toLowerCase(),
                created_at: createdAt,
                kind,
                tags,
                content
            };
            return { ...rumor, id: core.getEventHash(rumor) };
        },

        /**
         * Seal a rumor for one recipient. `nip44Encrypt` and `signEvent` are
         * capability handles backed by the wallet worker — the private key is
         * never passed to this module.
         *
         * @param {{ rumor: object, recipientPublicKey: string,
         *           nip44Encrypt: (plaintext: string, peerPublicKey: string) => Promise<string>,
         *           signEvent: (template: object) => Promise<object>,
         *           nowSeconds?: number }} params
         */
        async createSeal({ rumor, recipientPublicKey, nip44Encrypt, signEvent, nowSeconds = Math.floor(Date.now() / 1000) }) {
            const content = await nip44Encrypt(JSON.stringify(rumor), recipientPublicKey);
            return signEvent({
                kind: NOSTR_KIND_SEAL,
                created_at: jitteredTimestamp(nowSeconds),
                tags: [],
                content
            });
        },

        /**
         * Wrap a seal with a per-message throwaway key. No wallet capability is
         * needed here: the wrapping key is generated, used once and dropped.
         *
         * @param {{ seal: object, recipientPublicKey: string, nowSeconds?: number,
         *           ephemeralPrivateKey?: string }} params
         */
        wrapSeal({ seal, recipientPublicKey, nowSeconds = Math.floor(Date.now() / 1000), ephemeralPrivateKey = null }) {
            const privateKey = ephemeralPrivateKey || core.bytesToHex(core.randomBytes(32));
            const conversationKey = core.nip44ConversationKey(privateKey, recipientPublicKey);
            const content = core.nip44Encrypt(JSON.stringify(seal), conversationKey);
            return core.signEvent(
                {
                    kind: NOSTR_KIND_GIFT_WRAP,
                    created_at: jitteredTimestamp(nowSeconds),
                    tags: [['p', `${recipientPublicKey}`.toLowerCase()]],
                    content
                },
                privateKey
            );
        },

        /**
         * Unwrap a gift wrap received from a relay.
         *
         * Every layer is re-verified locally, because a relay is never an
         * authority: the wrap signature, the seal signature, the NIP-44 MACs
         * and — critically — that the rumor's claimed author is the same key
         * that signed the seal.
         *
         * @param {{ giftWrap: any,
         *           nip44Decrypt: (payload: string, peerPublicKey: string) => Promise<string>,
         *           localPublicKey: string }} params
         * @returns {Promise<{ rumor: any, seal: any, senderPublicKey: string }>}
         */
        async unwrap({ giftWrap, nip44Decrypt, localPublicKey }) {
            if (!core.verifyEvent(giftWrap)) throw new Error('Gift wrap failed signature verification.');
            if (giftWrap.kind !== NOSTR_KIND_GIFT_WRAP) throw new Error('Event is not a NIP-59 gift wrap.');

            const addressedTo = giftWrap.tags.find((tag) => tag[0] === 'p')?.[1];
            if (`${addressedTo || ''}`.toLowerCase() !== `${localPublicKey}`.toLowerCase()) {
                throw new Error('Gift wrap is not addressed to this identity.');
            }

            let seal;
            try {
                seal = JSON.parse(await nip44Decrypt(giftWrap.content, giftWrap.pubkey));
            } catch (_) {
                throw new Error('Failed to decrypt gift wrap: not the intended recipient or corrupted payload.');
            }

            if (!core.verifyEvent(seal)) throw new Error('Sealed event failed signature verification.');
            if (seal.kind !== NOSTR_KIND_SEAL) throw new Error('Wrapped event is not a NIP-59 seal.');
            if (Array.isArray(seal.tags) && seal.tags.length > 0) throw new Error('NIP-59 seals must not carry tags.');

            let rumor;
            try {
                rumor = JSON.parse(await nip44Decrypt(seal.content, seal.pubkey));
            } catch (_) {
                throw new Error('Failed to decrypt seal: not the intended recipient or corrupted payload.');
            }

            if (!rumor || typeof rumor !== 'object' || Array.isArray(rumor)) throw new Error('Malformed rumor payload.');
            if (`${rumor.pubkey || ''}`.toLowerCase() !== `${seal.pubkey}`.toLowerCase()) {
                throw new Error('Rumor author does not match the seal signer.');
            }
            if (typeof rumor.content !== 'string' || !Number.isInteger(rumor.kind)) throw new Error('Malformed rumor payload.');
            if (rumor.sig !== undefined) throw new Error('A NIP-59 rumor must be unsigned.');

            return { rumor, seal, senderPublicKey: `${seal.pubkey}`.toLowerCase() };
        }
    };
}
