// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';
import AuthController from '../../auth/AuthController.js';
import { bindPublishActions, renderDeployStage, setPublishButtonsState } from '../../ui/publish/PublishPanel.js';
import { renderPublishReview } from '../../ui/publish/PublishReviewModal.js';
import { renderSignatureStatus } from '../../ui/publish/SignatureStatus.js';
import { attachPublishMetadata } from '../../torrent/TorrentPublishService.js';
import { createTorrentChainArtifact } from '../../torrent/TorrentChainProtocol.js';
import {
    encodeSiteBundleGzip,
    SITE_BUNDLE_FILE_NAME,
    SITE_BUNDLE_SCHEMA,
    supportsNativeGzipStreams
} from '../../torrent/SiteBundleCodec.js';
import { hideDeployProgress, updateDeployProgress } from '../../ui/publish/DeployProgress.js';
import { initDeployWizard, updateDeployWizard } from '../../ui/publish/DeployWizard.js';
import ChannelsService from '../../channels/ChannelsService.js';
import { NostrDirectMessageSession } from '../../channels/NostrDirectMessageSession.js';
import { NostrRelayPool } from '../../nostr/NostrRelayPool.js';
import { verifyNostrEvent, normalizeNostrPublicKey, npubEncode, shortNpub } from '../../nostr/nostr.js';
import { lookupNostrProfile } from '../../nostr/NostrProfileLookup.js';
import { DEFAULT_NOSTR_DM_RELAYS, NOSTR_CONFIG } from '../../config/nostr.config.js';
import { createLocalWalletSigner } from '../../auth/LocalWalletService.js';
import {
    appendChannelsMessage,
    appendFileTransfer,
    bindChannelsPanel,
    bindFileInput,
    clearChannelsComposer,
    clearChannelsMessages,
    clearDmSearch,
    renderDmConnectionState,
    showDmStep,
    updateDmNostrIdentity
} from '../../ui/channels/ChannelsPanel.js';
import {
    bindContactsPanel,
    bindSaveContact,
    renderContacts,
    renderContactsLocked,
    renderSearchPresence
} from '../../ui/channels/ContactsPanel.js';
import { bindInvitationsPanel, renderInvitations } from '../../ui/channels/InvitationsPanel.js';
import { NostrPresenceService, INTENT } from '../../channels/NostrPresenceService.js';
import { ContactsStore, TRUST, filterContacts, verifyIdentityTuple } from '../../channels/ContactsStore.js';
import { PendingInvitations } from '../../channels/PendingInvitations.js';

const DEPLOY_SESSION_STORAGE_KEY = 'web25.deploy.session.v1';
/** How long a searched address shows "checking" before it is called offline. */
const DM_SEARCH_PRESENCE_GRACE_MS = 3000;
const DEPLOY_SESSION_MAX_AGE_MS = 30 * 60 * 1000;
const WEBTORRENT_CDN_URL = 'https://cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js';

function createDirectMessageSessionId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function directMessageRoomFromSession(sessionId) {
    return `room-${`${sessionId || ''}`.slice(0, 24)}`;
}

export async function init() {
    try {
        await this.loadRequiredLibraries();
        await this.initializeWebTorrent();
        await this.registerServiceWorker();
        this.setupEventListeners();
        this.setupCleanupHandlers();
        this.checkURL();
        this.updateDebugToggle();
        await this.initAuth();
        await this.restoreDeploySession();
    } catch (error) {
        console.error('PeerWeb initialization failed:', error);
        this.showError('Failed to initialize PeerWeb: ' + error.message);
    }
}

export async function initAuth() {
    this.authController = new AuthController(this.toast, {
        onDisconnect: async () => {
            await this.clearCache({ includeMemoryState: true, resetDeploySession: false });
        }
    });
    await this.authController.init();
    this.lastSignedPublish = null;
    this.lastSignature = null;
    this.lastPublishCandidate = null;
    this.lastDeployResult = null;
    this.setupAuthAwareUi(this.authController.state);
    this.refreshDeployUiState();
    initDeployWizard();
    renderSignatureStatus(null);
    renderPublishReview(null);
    renderDeployStage('Stage 1 · Select files', 'Artifact not staged');
    hideDeployProgress();
    this.authController.onChange((state) => this.setupAuthAwareUi(state));
    this.setupChannels();
}

export function setupChannels() {
    // The service is granted a signing handle, never the private key itself.
    const signer = createLocalWalletSigner();
    this.dmSigner = signer;
    this.channelsService = new ChannelsService({ signer });
    this.dmOfferSessionId = null;

    // Browser → public relays, directly. No proxy, no Web25 relay.
    this.nostrPool = new NostrRelayPool({ relays: DEFAULT_NOSTR_DM_RELAYS, verifyEvent: verifyNostrEvent });
    this.nostrDmSession = new NostrDirectMessageSession({
        pool: this.nostrPool,
        signer,
        onInvitation: (bootstrap, context) => this.handleNostrInvitation(bootstrap, context),
        onChatEnvelope: (wire) => this.channelsService.receiveNostrEnvelope(wire),
        onError: (error) => this.log(`Nostr Direct Messenger: ${error.message}`)
    });
    this.channelsService.setNostrFallback(this.nostrDmSession.createFallback());

    // Presence and intent are a separate layer on purpose: seeing somebody
    // online never starts a handshake, and no SDP exists until both sides ask.
    this.presenceService = new NostrPresenceService({
        pool: this.nostrPool,
        signer,
        onPresenceChange: (pubkey) => this.handlePresenceChange(pubkey),
        onIntentChange: (peer, state) => this.handleIntentChange(peer, state),
        onMutualIntent: (peer) => void this.startMutualConversation(peer),
        onError: (error) => this.log(`Nostr presence: ${error.message}`)
    });
    // A chat request is how a stranger reaches somebody for the first time, so
    // it has to be actionable: it is recorded as intent *and* surfaced as an
    // invitation the local user can accept or decline.
    this.nostrDmSession.onChatRequest = (peer) => this.handleChatRequest(peer);
    // Contacts are authorization, not authentication. Every record is
    // encrypted to the wallet's own Nostr identity, so a locked wallet has
    // nothing to read and this list simply cannot be shown.
    this.contactsStore = new ContactsStore({ signer });
    this.dmContacts = [];
    this.dmContactFilter = '';
    this.dmSelectedPeer = '';
    /**
     * A pubkey typed into the search box. Watched for presence alongside the
     * contacts so the user can see whether somebody is reachable *before*
     * requesting a chat, and dropped again when the search is cleared.
     */
    this.dmSearchedPeer = '';

    /**
     * Peers the local user has said yes to in this session, either by accepting
     * their invitation or by asking them first. Consent is what lets their
     * offer be answered when they are not (yet) a stored contact; without it
     * the two sides deadlock, each parking the other's offer.
     *
     * Session-scoped on purpose: a decision made in this tab does not silently
     * become a standing permission. Contacts are the durable record.
     * @type {Set<string>}
     */
    this.dmConsentedPeers = new Set();
    /**
     * Peers whose request was declined here. They are dropped in silence rather
     * than re-opening the panel on every retry — and still told nothing, since
     * an answer of any kind would confirm the npub is live.
     * @type {Set<string>}
     */
    this.dmDeclinedPeers = new Set();

    // Requests and offers from peers who are not approved contacts wait here.
    // Nothing is answered from this queue without a person pressing Accept.
    this.dmInvitations = new PendingInvitations();
    this.dmInvitations.onChange = () => renderInvitations(this.dmInvitations.list());

    bindContactsPanel({
        // Opening a contact expresses intent; it does not connect.
        onSelect: (contact) => void this.requestChatWith(contact.nostrPublicKey, contact.name),
        onFilter: (query) => {
            this.dmContactFilter = query;
            this.refreshContactList();
        },
        onRename: (contact) => void this.renameContact(contact.nostrPublicKey, contact.name),
        onRemove: (contact) => void this.removeContact(contact.nostrPublicKey, contact.name)
    });
    bindInvitationsPanel({
        onAccept: (peer) => void this.acceptDmInvitation(peer),
        onDecline: (peer) => void this.declineDmInvitation(peer)
    });
    renderInvitations([]);
    bindSaveContact(() => void this.saveCurrentPeerAsContact());
    void this.refreshContactList();

    bindChannelsPanel({
        onSearch: async (query) => {
            // Resolving the address is local and always works; the profile
            // lookup is a best-effort convenience on top of it.
            let nostrPublicKey;
            try {
                nostrPublicKey = normalizeNostrPublicKey(query);
            } catch (error) {
                throw new Error(error.message);
            }

            const identity = this.authController.getActiveIdentity();
            if (!identity?.address) {
                throw new Error('Unlock your wallet to search for a Nostr address.');
            }

            let profile = null;
            try {
                await this.nostrDmSession.start({ localAddress: identity.address });
                profile = await lookupNostrProfile({ pool: this.nostrPool, publicKey: nostrPublicKey });
            } catch (error) {
                // A relay that will not answer is not a failed search: the
                // address is still valid and messageable.
                this.log(`Nostr profile lookup unavailable: ${error.message}`);
            }

            // Presence for the address on screen, so the user can see whether a
            // request is likely to be seen. Read-only: it starts no handshake.
            this.watchSearchedPeer(nostrPublicKey);

            const npub = npubEncode(nostrPublicKey);
            return { nostrPublicKey, npub, shortNpub: shortNpub(npub), profile };
        },
        onStartChat: async (result) => {
            const identity = this.authController.getActiveIdentity();
            if (!identity?.address) {
                this.toast.warning('Authenticate first to use Direct Messenger.', 'Authentication required');
                return false;
            }
            return this.requestChatWith(
                result.nostrPublicKey,
                result.profile?.displayName || result.profile?.name || ''
            );
        },
        onLeave: async () => {
            await this.channelsService.leaveChannel();
            // Stay subscribed: leaving a conversation should not stop the user
            // being reachable at their npub.
            this.nostrDmSession?.clearPeer();
            if (this.dmSelectedPeer) this.presenceService?.clearIntent(this.dmSelectedPeer);
            this.dmSelectedPeer = '';
            this.dmOfferSessionId = null;
            this.stopWatchingSearchedPeer();
            clearDmSearch();
            renderDmConnectionState('idle');
            showDmStep('dm-choose-role');
        },
        onSend: async (text) => {
            try {
                const identity = this.authController.getActiveIdentity();
                await this.channelsService.sendChatMessage(text, identity);
                clearChannelsComposer();
            } catch (error) {
                this.toast.error(error.message, 'Direct Messenger');
            }
        }
    });

    bindFileInput(async (file) => {
        try {
            const identity = this.authController.getActiveIdentity();
            await this.channelsService.sendFile(file, identity);
        } catch (error) {
            this.toast.error(error.message, 'Direct Messenger');
        }
    });

    this.channelsService.onUpdate((event) => {
        // One indicator, one source of truth. `transport`, `connected`,
        // `peer-count` and `disconnected` all fold into this single state
        // inside ChannelsService, so nothing else renders connection status.
        if (event.type === 'connection-state') {
            renderDmConnectionState(event.state, { peerLabel: this.dmPeerLabel() });
            return;
        }
        if (
            event.type === 'transport' ||
            event.type === 'connecting' ||
            event.type === 'connected' ||
            event.type === 'disconnected' ||
            event.type === 'peer-count'
        ) {
            return;
        }
        if (event.type === 'left') {
            clearChannelsMessages();
        } else if (event.type === 'message') {
            appendChannelsMessage(event.message, event.local === true);
        } else if (event.type === 'file-incoming' || event.type === 'file-progress') {
            appendFileTransfer({
                fileId: event.fileId,
                fileName: event.fileName,
                fileSize: event.fileSize || 0,
                received: event.received || 0
            });
        } else if (event.type === 'file-ready') {
            appendFileTransfer({
                fileId: event.fileId,
                fileName: event.fileName,
                fileSize: 0,
                received: 0,
                url: event.url
            });
        } else if (event.type === 'error') {
            this.toast.error(event.error?.message || 'Unexpected direct messenger error', 'Direct Messenger');
        }
    });
}

/**
 * An invitation arrived through the relay pool.
 *
 * An `offer` is answered automatically with a gift-wrapped answer; an `answer`
 * completes the handshake for an offer this page sent. Both were already
 * validated (identity binding, TTL, replay) before reaching here.
 */
export async function handleNostrInvitation(bootstrap, context) {
    const identity = this.authController.getActiveIdentity();
    if (!identity?.address) return;

    try {
        if (bootstrap.role === 'offer') {
            // A cryptographically valid offer is not consent. Anyone who knows
            // this npub can produce one, and answering reveals the local ECIES
            // key, EVM identity and — through ICE gathering — this machine's
            // network position. So an offer from anyone who is not an approved
            // contact is parked, and nothing is sent back.
            const sender = `${context.senderNostrPublicKey}`.toLowerCase();

            let trusted = false;
            try {
                trusted = await this.contactsStore.isTrusted(sender);
            } catch (error) {
                // A locked wallet cannot read contacts, so nobody is trusted:
                // failing closed is the only safe reading of "unknown".
                this.log(`Trusted contacts unavailable, treating ${sender} as unknown: ${error.message}`);
                trusted = false;
            }

            // Consent given in this session counts as well as a stored contact.
            // Without it a first conversation cannot complete: both sides have
            // agreed, one of them offers, and the other parks the offer because
            // no contact record exists yet — so nobody ever answers.
            const consented = this.dmConsentedPeers?.has(sender) === true;

            if (!trusted && !consented) {
                await this.holdDmInvitation(bootstrap, sender);
                return;
            }

            // Either way the sender still has to be who they claim. A stored
            // contact is checked against its record, so a matching contact
            // alone never authorizes a connection; a peer the user just
            // accepted has no record to compare against, so the tuple is
            // checked for internal consistency instead.
            const identityHolds = trusted
                ? await this.invitationMatchesContact(bootstrap, sender)
                : verifyIdentityTuple({
                      nostrPublicKey: sender,
                      eciesPublicKey: bootstrap?.from?.eciesPublicKey,
                      evmAddress: bootstrap?.from?.evmAddress
                  }).ok;
            if (!identityHolds) {
                await this.holdDmInvitation(bootstrap, sender, 'identity mismatch');
                return;
            }

            // An open conversation is not interrupted by an unsolicited third
            // party either.
            const boundPeer = this.nostrDmSession.peerNostrPublicKey;
            if (this.channelsService.currentChannel && boundPeer && boundPeer !== sender) {
                this.log(`Ignoring a Direct Messenger invitation from ${sender} during an active session.`);
                return;
            }

            await this.answerDmInvitation(bootstrap, sender, identity);
            this.toast.success(
                trusted ? 'Trusted contact connected.' : 'Connecting to the peer you accepted…',
                'Direct Messenger'
            );
            return;
        }

        if (bootstrap.role === 'answer') {
            await this.channelsService.applyRemoteAnswerPayload({
                description: bootstrap.webrtc.description,
                evmAddress: bootstrap.from.evmAddress,
                publicKey: bootstrap.from.eciesPublicKey
            });
            this.nostrDmSession.setPeer(context.senderNostrPublicKey);
            this.dmSelectedPeer = `${context.senderNostrPublicKey}`.toLowerCase();
            this.toast.success('Peer answered. Establishing the direct connection…', 'Direct Messenger');
        }
    } catch (error) {
        this.toast.error(error.message, 'Direct Messenger');
    }
}

/**
 * An inbound chat request — "I would like to talk to you".
 *
 * This is first contact, and it used to be a dead end: the request was recorded
 * as intent and announced in a toast telling the local user to go and select
 * the sender themselves. Nothing was clickable, so a stranger could only be
 * reached by both people independently searching for each other.
 *
 * A request now behaves like the invitation it is. The privacy guarantee is
 * unchanged — no answer, no ICE, no key material leaves this browser until a
 * person presses Accept — but the decision is presented instead of implied.
 *
 * @param {string} peerNostrPublicKey
 */
export async function handleChatRequest(peerNostrPublicKey) {
    const sender = `${peerNostrPublicKey || ''}`.toLowerCase();
    if (!sender) return;

    // Intent is recorded either way: it is what makes the pair mutual once the
    // local user consents, and it costs nothing to know somebody asked.
    this.presenceService?.receiveChatRequest(sender);

    // Somebody who was already declined here is dropped in silence. They are
    // told nothing — an answer of any kind confirms the npub is live.
    if (this.dmDeclinedPeers?.has(sender)) {
        this.log(`Ignoring a repeat chat request from ${sender}: previously declined.`);
        return;
    }

    // Already decided in the other direction: no second decision to make.
    if (this.dmConsentedPeers?.has(sender)) return;

    let trusted = false;
    try {
        trusted = await this.contactsStore.isTrusted(sender);
    } catch (error) {
        // A locked wallet cannot read contacts, so nobody is trusted.
        this.log(`Trusted contacts unavailable, treating ${sender} as unknown: ${error.message}`);
        trusted = false;
    }

    if (trusted) {
        // A friend does not have to ask twice: consent was given when they were
        // saved as a contact, so their request is answered with ours and the
        // handshake starts on its own.
        try {
            await this.consentToChatWith(sender);
            this.toast.info('A trusted contact wants to chat — connecting…', 'Direct Messenger');
        } catch (error) {
            this.log(`Could not answer a trusted contact's chat request: ${error.message}`);
        }
        return;
    }

    await this.holdChatRequest(sender);
}

/**
 * Park a chat request from a peer who is not an approved contact.
 *
 * Nothing is negotiated and nothing is sent: the entry carries the sender's
 * npub and a best-effort profile name, which is all a request contains. Their
 * ECIES key and EVM address are not in a request at all, and are verified when
 * their offer arrives after consent.
 *
 * @param {string} sender
 */
export async function holdChatRequest(sender) {
    let profileName = '';
    try {
        const profile = await lookupNostrProfile({ pool: this.nostrPool, publicKey: sender });
        profileName = profile?.displayName || profile?.name || '';
    } catch (error) {
        this.log(`Nostr profile lookup unavailable for a chat request: ${error.message}`);
    }

    this.dmInvitations.add({
        kind: 'request',
        senderNostrPublicKey: sender,
        npub: npubEncode(sender),
        profileName,
        trustState: 'unknown',
        // A request is intent, and intent goes stale: the queue drops it on the
        // same clock that stops it counting towards a mutual pair.
        expiresAt: Date.now() + NOSTR_CONFIG.CHAT_REQUEST_TTL_MS
    });

    this.log(`Holding a chat request from ${sender}. Nothing sent, no ICE gathered.`);
    this.toast.info('Someone would like to chat. Accept or decline the invitation.', 'Chat invitation');
}

/**
 * Say yes to a peer: remember the consent, then tell them.
 *
 * Sending our own chat request is what completes the pair, and the presence
 * layer starts the handshake from there — exactly one side offers, and
 * whichever side that is, the other now answers instead of parking it.
 *
 * @param {string} peerNostrPublicKey
 */
export async function consentToChatWith(peerNostrPublicKey) {
    const peer = `${peerNostrPublicKey || ''}`.toLowerCase();
    const identity = this.authController.getActiveIdentity();
    if (!identity?.address) throw new Error('Unlock your wallet to start a conversation.');

    await this.nostrDmSession.start({ localAddress: identity.address });

    // Recorded before the send: an offer that crosses with our request must
    // find consent already in place, or it would be parked for no reason.
    this.dmConsentedPeers.add(peer);
    this.dmDeclinedPeers.delete(peer);
    this.dmSelectedPeer = peer;

    // Any entry still waiting in the panel for this peer is answered by the
    // consent itself, so it should not sit there asking a question the user
    // has just answered somewhere else.
    this.dmInvitations?.remove(peer);

    return this.presenceService.sendChatRequest(peer, (target, kind, content) =>
        this.nostrDmSession.sendGiftWrapped(target, kind, content)
    );
}

/**
 * Park an invitation from a peer who is not an approved contact.
 *
 * This is the whole privacy guarantee. Everything that would reveal something
 * about the local user is deliberately *not* done here:
 *
 *   - `createAnswerPayloadFromRemoteOffer()` is not called, so no
 *     `RTCPeerConnection` exists and **no ICE gathering happens** — an attacker
 *     who knows an npub cannot learn this machine's addresses by offering;
 *   - no answer is sent, so the local full ECIES public key and EVM identity
 *     stay unrevealed;
 *   - nothing is written to the contacts store.
 *
 * The peer learns only that their gift wrap was published, which they already
 * knew.
 *
 * @param {any} bootstrap
 * @param {string} sender
 * @param {string} [reason]
 */
export async function holdDmInvitation(bootstrap, sender, reason = 'not an approved contact') {
    const npub = npubEncode(sender);

    // The profile name is a convenience for recognising the sender and is
    // best-effort: a relay that will not answer must not stop the invitation
    // being shown, and a name never stands in for the npub.
    let profileName = '';
    try {
        const profile = await lookupNostrProfile({ pool: this.nostrPool, publicKey: sender });
        profileName = profile?.displayName || profile?.name || '';
    } catch (error) {
        this.log(`Nostr profile lookup unavailable for a pending invitation: ${error.message}`);
    }

    this.dmInvitations.add({
        bootstrap,
        senderNostrPublicKey: sender,
        npub,
        profileName,
        trustState: 'unknown'
    });

    this.log(`Holding a Direct Messenger invitation from ${sender}: ${reason}. No answer sent, no ICE gathered.`);
    this.toast.info('A peer wants to chat. Review the invitation before connecting.', 'Chat invitation');
}

/**
 * Does an invitation's identity tuple still match the stored contact?
 *
 * A contact record is three bound identities, not three strings that happen to
 * sit together. Both the invitation's own tuple and its agreement with what was
 * stored are re-checked, so a tampered record — or a peer reusing an npub with
 * a different key — is refused even though a contact by that name exists.
 *
 * @param {any} bootstrap
 * @param {string} sender
 */
export async function invitationMatchesContact(bootstrap, sender) {
    const claimed = {
        nostrPublicKey: sender,
        eciesPublicKey: `${bootstrap?.from?.eciesPublicKey || ''}`,
        evmAddress: `${bootstrap?.from?.evmAddress || ''}`
    };

    const verification = verifyIdentityTuple(claimed);
    if (!verification.ok) {
        this.log(`Invitation identity tuple rejected for ${sender}: ${verification.reason}`);
        return false;
    }

    let contact = null;
    try {
        contact = await this.contactsStore.get(sender);
    } catch (error) {
        this.log(`Trusted contacts unavailable while verifying ${sender}: ${error.message}`);
        return false;
    }
    if (!contact) return false;

    const sameEcies = contact.eciesPublicKey === claimed.eciesPublicKey.trim().toLowerCase();
    const sameEvm = contact.evmAddress === claimed.evmAddress.trim().toLowerCase();
    if (!sameEcies || !sameEvm) {
        this.log(`Invitation from ${sender} does not match the stored contact identity.`);
        return false;
    }

    return true;
}

/**
 * Create and send the answer. Only reached for a trusted contact, or after the
 * local user has explicitly accepted — this is the first point at which ICE is
 * gathered and the local identity is revealed.
 *
 * @param {any} bootstrap
 * @param {string} sender
 * @param {any} identity
 */
export async function answerDmInvitation(bootstrap, sender, identity) {
    const derivedRoom = directMessageRoomFromSession(bootstrap.session.sessionId);
    const offerPayload = {
        description: bootstrap.webrtc.description,
        evmAddress: bootstrap.from.evmAddress,
        publicKey: bootstrap.from.eciesPublicKey
    };
    const answerSignal = await this.channelsService.createAnswerPayloadFromRemoteOffer(
        derivedRoom,
        offerPayload,
        identity
    );
    this.nostrDmSession.setPeer(sender);
    this.dmSelectedPeer = sender;
    await this.nostrDmSession.sendInvitation({
        identity,
        eciesPublicKey: answerSignal.publicKey,
        role: 'answer',
        webrtcDescription: answerSignal.description,
        recipient: sender,
        // The peer's full ECIES key is known now, so the answer gets the
        // Web25 ECIES envelope on top of the NIP-44 gift wrap.
        recipientEciesPublicKey: bootstrap.from.eciesPublicKey,
        replyToSessionId: bootstrap.session.sessionId
    });
    return answerSignal;
}

/**
 * Accept a pending invitation.
 *
 * Consent alone is not enough: validity, expiry and the identity bindings are
 * all re-checked at this moment, because the invitation has been sitting in a
 * queue since it arrived and the person may have taken a while to decide.
 *
 * @param {string} peerNostrPublicKey
 */
export async function acceptDmInvitation(peerNostrPublicKey) {
    const identity = this.authController.getActiveIdentity();
    if (!identity?.address) {
        this.toast.warning('Authenticate first to accept a chat invitation.', 'Authentication required');
        return false;
    }

    const invitation = this.dmInvitations.take(peerNostrPublicKey);
    if (!invitation) {
        this.toast.warning('That invitation is no longer available.', 'Chat invitation');
        return false;
    }

    const sender = invitation.peerNostrPublicKey;
    const bootstrap = invitation.bootstrap;

    // Re-check expiry: an invitation that timed out while it waited must not be
    // answered, because the peer has already given up on that session.
    if (invitation.expiresAt && invitation.expiresAt <= Date.now()) {
        this.toast.warning('That invitation expired. Ask them to try again.', 'Chat invitation');
        return false;
    }

    // A request carries no SDP and no keys, so there is nothing to answer yet.
    // Accepting it means consenting: our own request goes back, the pair
    // becomes mutual, and the handshake starts from the presence layer. Their
    // identity tuple is verified when their offer arrives — there is nothing
    // to verify in a request.
    if (invitation.kind === 'request') {
        try {
            await this.consentToChatWith(sender);
            // Kept for "Save as contact" once the conversation is up: the peer
            // is not stored yet, because no verified keys exist for them.
            this.dmPendingContactName = invitation.profileName || '';
            this.toast.success('Invitation accepted; connecting…', 'Direct Messenger');
            return true;
        } catch (error) {
            this.toast.error(error.message, 'Direct Messenger');
            return false;
        }
    }

    // Re-check the bindings on the invitation itself. This is the same tuple
    // check a trusted contact goes through; there is no contact to compare
    // against yet, so only internal consistency can be required here.
    const verification = verifyIdentityTuple({
        nostrPublicKey: sender,
        eciesPublicKey: bootstrap?.from?.eciesPublicKey,
        evmAddress: bootstrap?.from?.evmAddress
    });
    if (!verification.ok) {
        this.toast.error(`Invitation rejected: ${verification.reason}`, 'Chat invitation');
        return false;
    }

    try {
        this.dmConsentedPeers.add(sender);
        this.dmDeclinedPeers.delete(sender);
        const answerSignal = await this.answerDmInvitation(bootstrap, sender, identity);

        // Persisted as a friend only now, once the authenticated identity and
        // key exchange has actually produced an answer for this exact tuple.
        await this.contactsStore.save({
            nostrPublicKey: sender,
            npub: invitation.npub || npubEncode(sender),
            eciesPublicKey: bootstrap.from.eciesPublicKey,
            evmAddress: bootstrap.from.evmAddress,
            name: invitation.profileName || '',
            trust: TRUST.TRUSTED
        });
        await this.refreshContactList();

        // Record our own outgoing intent, so presence sees the pair as mutual
        // and the existing WebRTC-first / Nostr-fallback path continues as
        // before. `sendChatRequest` needs the gift-wrap sender as its second
        // argument — called with one, it rejects and the intent is never
        // recorded.
        //
        // Best-effort on purpose: the answer is already sent and the contact
        // already stored by this point, so a relay hiccup here must not report
        // the acceptance as failed.
        try {
            await this.presenceService?.sendChatRequest(sender, (peer, kind, content) =>
                this.nostrDmSession.sendGiftWrapped(peer, kind, content)
            );
        } catch (error) {
            this.log(`Accepted ${sender} but could not announce intent: ${error.message}`);
        }

        this.toast.success('Invitation accepted; connecting…', 'Direct Messenger');
        return Boolean(answerSignal);
    } catch (error) {
        this.toast.error(error.message, 'Direct Messenger');
        return false;
    }
}

/**
 * Decline a pending invitation.
 *
 * The invitation is discarded and that is all: no answer is sent, no
 * connection is attempted, and no contact is created. The peer is told nothing,
 * because telling them would itself confirm that this npub is live and
 * listening.
 *
 * @param {string} peerNostrPublicKey
 */
export async function declineDmInvitation(peerNostrPublicKey) {
    const invitation = this.dmInvitations.take(peerNostrPublicKey);
    if (!invitation) return false;

    const sender = invitation.peerNostrPublicKey;
    // A declined peer stays declined for this session: repeats are dropped
    // without re-opening the panel, so somebody cannot nag their way in. Any
    // intent they announced is dropped too, or a later request of our own to
    // an unrelated peer could find a stale pair waiting to turn mutual.
    this.dmDeclinedPeers.add(sender);
    this.dmConsentedPeers.delete(sender);
    this.presenceService?.clearIntent(sender);

    this.log(`Declined a Direct Messenger invitation from ${sender}.`);
    this.toast.info('Invitation declined.', 'Chat invitation');
    return true;
}

/**
 * Rename a contact. Only the local label changes; identity is untouched.
 * @param {string} nostrPublicKey
 * @param {string} currentName
 */
export async function renameContact(nostrPublicKey, currentName = '') {
    const name = window.prompt('Name for this contact (stored only in this browser):', currentName);
    if (name === null) return false;
    try {
        await this.contactsStore.rename(nostrPublicKey, name);
        await this.refreshContactList();
        return true;
    } catch (error) {
        this.toast.error(error.message, 'Contacts');
        return false;
    }
}

/**
 * Remove a contact.
 *
 * Purely an authorization change: the peer becomes unknown again, so their next
 * invitation waits for approval like any stranger's. No wallet or Nostr key is
 * deleted or rotated.
 *
 * @param {string} nostrPublicKey
 * @param {string} name
 */
export async function removeContact(nostrPublicKey, name = '') {
    const label = name || shortNpub(npubEncode(nostrPublicKey));
    if (!window.confirm(`Remove ${label}? Future invitations from them will need your approval again.`)) {
        return false;
    }
    try {
        await this.contactsStore.remove(nostrPublicKey);
        await this.refreshContactList();
        this.toast.success('Contact removed. They are an unknown peer again.', 'Contacts');
        return true;
    } catch (error) {
        this.toast.error(error.message, 'Contacts');
        return false;
    }
}

/** Short label for whoever the current conversation is with. */
export function dmPeerLabel() {
    const peer = this.dmSelectedPeer;
    if (!peer) return '';
    const contact = (this.dmContacts || []).find((entry) => entry.nostrPublicKey === peer);
    if (contact?.name) return contact.name;
    return `${peer.slice(0, 8)}…`;
}

/**
 * Reload contacts and repaint the list with live presence.
 *
 * Reading requires an unlocked wallet, because every record is decrypted
 * through the wallet worker. When that fails the list is not merely empty: the
 * UI says so, and `dmContacts` is cleared so no decrypted contact lingers in
 * main-thread state after a lock.
 */
export async function refreshContactList() {
    try {
        this.dmContacts = await this.contactsStore.list();
    } catch (error) {
        this.log(`Contacts unavailable: ${error.message}`);
        this.dmContacts = [];
        this.presenceService?.watch([]);
        renderContactsLocked();
        return;
    }

    this.watchPresenceTargets();

    renderContacts(filterContacts(this.dmContacts, this.dmContactFilter), {
        isOnline: (pubkey) => Boolean(this.presenceService?.isOnline(pubkey)),
        selectedKey: this.dmSelectedPeer
    });
}

/**
 * Everyone whose presence beacon is worth subscribing to right now.
 *
 * `watch()` replaces the whole subscription set rather than adding to it, so
 * the contacts and any address currently in the search box have to be combined
 * here. Anyone else is noise.
 */
export function watchPresenceTargets() {
    const targets = (this.dmContacts || []).map((contact) => contact.nostrPublicKey);
    if (this.dmSearchedPeer) targets.push(this.dmSearchedPeer);
    this.presenceService?.watch(targets);
}

/**
 * A beacon arrived (or lapsed) for someone we are watching.
 * @param {string} pubkey
 */
export function handlePresenceChange(pubkey) {
    const peer = `${pubkey || ''}`.toLowerCase();
    if (this.dmSearchedPeer && peer === this.dmSearchedPeer) {
        renderSearchPresence(Boolean(this.presenceService?.isOnline(this.dmSearchedPeer)));
    }
    void this.refreshContactList();
}

/**
 * Watch a searched address for presence, temporarily.
 *
 * Being online is not an invitation and this starts no handshake: it is a
 * read-only subscription to a public NIP-38 beacon, so the user can see whether
 * a request is likely to be seen soon before they send one.
 *
 * @param {string} nostrPublicKey
 */
export function watchSearchedPeer(nostrPublicKey) {
    this.dmSearchedPeer = `${nostrPublicKey || ''}`.toLowerCase();
    if (!this.dmSearchedPeer) {
        renderSearchPresence(null);
        this.watchPresenceTargets();
        return;
    }

    // Subscribing is instant; a beacon is not. Say "checking" rather than
    // reporting a not-yet-received beacon as offline.
    renderSearchPresence(this.presenceService?.isOnline(this.dmSearchedPeer) ? true : 'checking');
    this.watchPresenceTargets();

    // If nothing has arrived within the beacon window, offline is now the
    // honest answer rather than a guess.
    clearTimeout(this._dmSearchPresenceTimer);
    this._dmSearchPresenceTimer = setTimeout(() => {
        if (!this.dmSearchedPeer) return;
        renderSearchPresence(Boolean(this.presenceService?.isOnline(this.dmSearchedPeer)));
    }, DM_SEARCH_PRESENCE_GRACE_MS);
}

/** Stop watching a searched address once it is no longer on screen. */
export function stopWatchingSearchedPeer() {
    clearTimeout(this._dmSearchPresenceTimer);
    this.dmSearchedPeer = '';
    renderSearchPresence(null);
    this.watchPresenceTargets();
}

/**
 * Express intent to talk to a peer.
 *
 * This is all that selecting a contact or a search result does. No WebRTC
 * offer is created and no SDP exists yet; the conversation begins only when the
 * peer has selected us back.
 *
 * @param {string} nostrPublicKey
 * @param {string} [suggestedName]
 */
export async function requestChatWith(nostrPublicKey, suggestedName = '') {
    const identity = this.authController.getActiveIdentity();
    if (!identity?.address) {
        this.toast.warning('Authenticate first to use Direct Messenger.', 'Authentication required');
        return false;
    }

    try {
        this.dmPendingContactName = suggestedName;

        // Asking somebody is consent to their reply. Without recording it here
        // the peer's offer — which is what we just invited — would be parked as
        // if it came from a stranger.
        const state = await this.consentToChatWith(nostrPublicKey);

        renderSearchPresence(this.presenceService.isOnline(this.dmSelectedPeer));
        await this.refreshContactList();

        if (state === INTENT.MUTUAL) {
            // They had already asked; this completes the pair.
            this.toast.success('Both of you want to talk — connecting…', 'Direct Messenger');
            return true;
        }

        this.channelsService.setPreConnectionState('awaiting-peer');
        renderDmConnectionState('awaiting-peer', { peerLabel: this.dmPeerLabel() });
        this.toast.info('Request sent. It waits as an invitation for them to accept.', 'Direct Messenger');
        return true;
    } catch (error) {
        this.toast.error(error.message, 'Direct Messenger');
        return false;
    }
}

/**
 * Reflect an intent change in the UI without connecting anything.
 * @param {string} peer
 * @param {string} state
 */
export function handleIntentChange(_peer, _state) {
    // An inbound request is surfaced as an invitation with Accept and Decline
    // by `handleChatRequest`, so there is nothing to announce twice. Intent
    // still moves the contact list, which shows who is waiting on whom.
    void this.refreshContactList();
}

/**
 * Intent is now mutual, so a handshake may finally begin.
 *
 * Exactly one side offers, chosen deterministically, or both would offer at
 * once and neither would answer.
 *
 * @param {string} peer
 */
export async function startMutualConversation(peer) {
    const identity = this.authController.getActiveIdentity();
    if (!identity?.address) return;

    this.dmSelectedPeer = `${peer}`.toLowerCase();
    this.nostrDmSession.setPeer(this.dmSelectedPeer);
    this.channelsService.setPreConnectionState('handshake');
    renderDmConnectionState('handshake', { peerLabel: this.dmPeerLabel() });

    if (!this.presenceService.shouldInitiate(this.dmSelectedPeer)) {
        // The other side offers; our invitation will arrive over Nostr.
        return;
    }

    try {
        clearChannelsMessages();
        const offerSessionId = createDirectMessageSessionId();
        const sharedRoom = directMessageRoomFromSession(offerSessionId);
        const signal = await this.channelsService.createHostOfferPayload(sharedRoom, identity);

        const { bootstrap } = await this.nostrDmSession.sendInvitation({
            identity,
            eciesPublicKey: signal.publicKey,
            role: 'offer',
            webrtcDescription: signal.description,
            recipient: this.dmSelectedPeer,
            sessionId: offerSessionId
        });
        this.dmOfferSessionId = bootstrap.session.sessionId;
    } catch (error) {
        this.toast.error(error.message, 'Direct Messenger');
    }
}

/** Save whoever the current conversation is with, under a name of your choosing. */
export async function saveCurrentPeerAsContact() {
    const peer = this.dmSelectedPeer;
    if (!peer) {
        this.toast.warning('Open a conversation first.', 'Contacts');
        return false;
    }

    const suggested = this.dmPendingContactName || '';
    const name = window.prompt('Name for this contact (stored only in this browser):', suggested);
    if (name === null) return false;

    try {
        // The peer's full ECIES key and EVM address are known only because an
        // invitation was cryptographically verified; the store re-checks that
        // they and the npub are one key before writing anything.
        await this.contactsStore.save({
            nostrPublicKey: peer,
            npub: npubEncode(peer),
            eciesPublicKey: this.channelsService.peerPublicKey || '',
            evmAddress: this.channelsService.peerAddress || '',
            name,
            trust: TRUST.TRUSTED
        });
        await this.refreshContactList();
        this.toast.success('Contact saved locally and trusted for direct reconnects.', 'Contacts');
        return true;
    } catch (error) {
        this.toast.error(error.message, 'Contacts');
        return false;
    }
}

export function showDirectMessageProgress(message) {
    this.showUploadProgress(message);
}

export function hideDirectMessageProgress() {
    this.hideUploadProgress();
}

export function refreshDeployUiState() {
    const hasFiles = Boolean(this.pendingDeployFiles && this.pendingDeployFiles.length > 0);
    const hasSignature = Boolean(this.lastSignature && this.lastSignedPublish);
    setPublishButtonsState({ canSign: hasFiles, canDeploy: hasFiles && hasSignature });
    updateDeployWizard({ hasFiles, hasSignature, hasDeployResult: Boolean(this.lastDeployResult) });
}

export function invalidateSignedState(message = 'Signature invalidated') {
    this.lastSignature = null;
    this.lastSignedPublish = null;
    this.clearDeploySession();

    renderSignatureStatus(null);
    renderPublishReview(null);

    const output = document.getElementById('publish-output');
    if (output) {
        output.textContent = `${message}. Re-sign the current artifact before deployment.`;
    }

    const signedBy = document.getElementById('result-signed-by');
    const signatureStatus = document.getElementById('result-signature-status');
    if (signedBy) signedBy.textContent = 'Not signed';
    if (signatureStatus) signatureStatus.textContent = 'UNVERIFIED';

    this.refreshDeployUiState();
    renderDeployStage('Artifact staged', message);
}

export function getSignedPayloadInput(hash, createdAt) {
    const identity = this.authController.getActiveIdentity();
    return {
        torrentHash: hash,
        siteName: this.generateTorrentName(this.pendingDeployFiles || []),
        createdAt,
        publisherAddress: identity.address,
        contentRoot: hash,
        chainId: identity.chainId || 1
    };
}

export async function signStagedPayload() {
    if (!this.pendingDeployFiles || this.pendingDeployFiles.length === 0) {
        throw new Error('Select files before signing.');
    }

    const identity = this.authController.getActiveIdentity();
    if (!identity.address || !identity.identityType) {
        throw new Error('Authenticate before signing.');
    }

    renderDeployStage('Signing', 'Preparing in-memory deploy bundle for signature');
    updateDeployProgress({ label: 'Reading files into browser memory', percent: 10, state: 'running' });

    const createdAt = new Date().toISOString();
    updateDeployProgress({ label: 'Normalizing bundle paths', percent: 25, state: 'running' });

    if (this.lastPublishCandidate?.torrent?.destroy) {
        try {
            this.lastPublishCandidate.torrent.destroy();
        } catch (_) {}
    }

    const inMemoryFiles = await this.buildInMemoryDeployBundle(this.pendingDeployFiles, ({ label, percent }) =>
        updateDeployProgress({ label, percent, state: 'running' })
    );

    const usingGzipBundle = PEERWEB_CONFIG.SITE_BUNDLE_MODE === 'gzip' && supportsNativeGzipStreams;
    let deployPayloadFiles = inMemoryFiles;
    let bundleMetadata = null;

    if (PEERWEB_CONFIG.SITE_BUNDLE_MODE === 'gzip' && !supportsNativeGzipStreams) {
        this.log(
            'Gzip bundle mode requested but CompressionStream/DecompressionStream is unavailable. Falling back to files mode.'
        );
        this.toast?.warning?.(
            'Gzip bundle mode is unavailable in this browser (missing CompressionStream/DecompressionStream). Falling back to standard files mode.',
            'Gzip mode unavailable'
        );
    }

    if (usingGzipBundle) {
        updateDeployProgress({ label: 'Encoding site.bundle.json.gz payload', percent: 45, state: 'running' });
        const bundleInputFiles = [];
        for (const file of inMemoryFiles) {
            const path = this.getNormalizedDeployPath(file);
            const bytes = new Uint8Array(await file.arrayBuffer());
            bundleInputFiles.push({
                path,
                contentType: file.type || this.getContentType(path),
                bytes
            });
        }

        const entryPath = bundleInputFiles
            .map((entry) => entry.path)
            .find((path) => path.toLowerCase() === 'index.html' || path.toLowerCase().endsWith('/index.html'));
        const encodedBundle = await encodeSiteBundleGzip(bundleInputFiles, { entryPath });
        bundleMetadata = {
            name: SITE_BUNDLE_FILE_NAME,
            sha256: encodedBundle.sha256,
            contentEncoding: 'gzip',
            schema: SITE_BUNDLE_SCHEMA
        };
        deployPayloadFiles = [
            this.createVirtualBundleFile(SITE_BUNDLE_FILE_NAME, encodedBundle.gzipBytes, 'application/gzip')
        ];
    }

    updateDeployProgress({ label: 'Generating .torrentchain signature manifest', percent: 55, state: 'running' });

    const chainArtifact = await createTorrentChainArtifact({
        inMemoryFiles,
        publisher: identity.address,
        chainId: identity.chainId || 1,
        identityType: identity.identityType,
        createdAt,
        bundle: bundleMetadata,
        filesSemantics: usingGzipBundle ? 'bundle-contents' : 'torrent-entries'
    });

    const torrentChainFile = this.createVirtualBundleFile('.torrentchain', chainArtifact.content, 'application/json');
    const prepared = await this.seedInMemoryDeployBundle(
        [torrentChainFile, ...deployPayloadFiles],
        this.pendingDeployFiles,
        ({ label, percent }) => updateDeployProgress({ label, percent, state: 'running' })
    );

    this.lastPublishCandidate = {
        hash: prepared.infoHash,
        siteName: prepared.name,
        torrentFile: prepared.torrentFile,
        torrent: prepared,
        createdAt
    };

    const payloadInput = this.getSignedPayloadInput(prepared.infoHash, createdAt);
    renderPublishReview(payloadInput);

    const signature = {
        payload: chainArtifact.payload,
        message: chainArtifact.message,
        signature: chainArtifact.signature,
        signatureAlgorithm: chainArtifact.signatureAlgorithm,
        signedAt: createdAt
    };

    this.lastSignature = signature;
    this.lastSignedPublish = attachPublishMetadata(prepared.infoHash, signature);
    this.lastPublishCandidate.signedTorrentFile = prepared.torrentFile;
    this.persistDeploySession();

    renderSignatureStatus(signature);
    renderPublishReview(signature.payload);

    const output = document.getElementById('publish-output');
    if (output) {
        output.textContent = JSON.stringify(
            {
                state: 'signature-confirmed',
                signedBy: identity.address,
                signatureAlgorithm: signature.signatureAlgorithm,
                payload: signature.payload,
                signature: signature.signature,
                torrentEmbedding: '.torrentchain bundle manifest'
            },
            null,
            2
        );
    }

    updateDeployProgress({ label: 'Signature confirmed', percent: 100, state: 'success' });
    renderDeployStage('Signature ready', 'Signed in-memory bundle ready for deployment');
    this.refreshDeployUiState();
}

export function renderDeploymentSummary({ hash, url, signedBy, signature, signatureStatus }) {
    const resultEl = document.getElementById('upload-result');
    const hashEl = document.getElementById('result-hash');
    const urlEl = document.getElementById('result-url');
    const signedByEl = document.getElementById('result-signed-by');
    const signatureEl = document.getElementById('result-signature-preview');
    const signatureStatusEl = document.getElementById('result-signature-status');

    if (hashEl) hashEl.textContent = hash;
    if (urlEl) urlEl.textContent = url;
    if (signedByEl) signedByEl.textContent = signedBy || 'Unknown';
    if (signatureEl) signatureEl.textContent = signature ? `${signature.slice(0, 24)}...` : 'N/A';
    if (signatureStatusEl) signatureStatusEl.textContent = signatureStatus || 'UNVERIFIED';

    if (resultEl) resultEl.classList.remove('hidden');
}

export async function deploySignedArtifact() {
    if (!this.lastPublishCandidate || !this.lastSignature || !this.lastSignedPublish) {
        throw new Error('A valid signature is required before deployment.');
    }

    const hash = this.lastPublishCandidate.hash;
    const identity = this.authController.getActiveIdentity();

    renderDeployStage('Deploying', 'Finalizing signed in-memory torrent deployment');
    updateDeployProgress({ label: 'Finalizing deployment', percent: 85, state: 'running' });

    this.showUploadResult(
        hash,
        this.lastPublishCandidate.signedTorrentFile || this.lastPublishCandidate.torrentFile,
        this.lastPublishCandidate.torrent
    );

    const output = document.getElementById('publish-output');
    if (output) {
        output.textContent = JSON.stringify(
            {
                deploymentStatus: 'completed',
                torrentHash: hash,
                artifactMode: 'in-memory-bundle',
                signedBy: identity.address,
                signature: this.lastSignature.signature,
                signatureAlgorithm: this.lastSignature.signatureAlgorithm || 'EVM_SECP256K1',
                signedAt: this.lastSignature.signedAt,
                authenticity: {
                    integrity: 'Torrent hash guarantees content integrity',
                    authorship: 'Wallet signature is embedded in .torrentchain and verified before site rendering'
                },
                signatureStorage: ['.torrentchain']
            },
            null,
            2
        );
    }

    const url = `${window.location.origin}${window.location.pathname}?orc=${hash}`;
    this.renderDeploymentSummary({
        hash,
        url,
        signedBy: identity.address,
        signature: this.lastSignature.signature,
        signatureStatus: 'VERIFIED'
    });

    this.lastDeployResult = { hash, url, signedBy: identity.address };
    this.persistDeploySession();
    updateDeployProgress({ label: 'Seeding live', percent: 100, state: 'success' });
    renderDeployStage('Deployment complete', 'Live and seeding from memory');
}

export function setupAuthAwareUi(state) {
    const identityTabBtn = document.querySelector('[data-tab="auth"]');
    const identityTabPanel = document.getElementById('tab-auth');
    const deployWall = document.getElementById('deploy-auth-wall');
    const deployPanel = document.getElementById('deploy-panel');
    const channelsTabBtn = document.querySelector('[data-tab="channels"]');
    const channelsTabPanel = document.getElementById('tab-channels');
    const hasIdentity = Boolean(state.localWalletUnlocked && state.address && state.identityType);
    const isAuthenticated = Boolean(state.localWalletUnlocked && state.address && state.identityType);
    const hasJustAuthenticated = !this._hadAuthenticatedIdentity && isAuthenticated;
    this._hadAuthenticatedIdentity = isAuthenticated;

    if (identityTabBtn) {
        identityTabBtn.style.display = hasIdentity ? 'inline-flex' : 'none';
    }
    if (identityTabPanel) {
        if (hasIdentity) {
            identityTabPanel.style.removeProperty('display');
        } else {
            identityTabPanel.style.display = 'none';
        }
    }
    if (deployWall) {
        deployWall.classList.toggle('hidden', isAuthenticated);
    }
    if (deployPanel) {
        deployPanel.classList.toggle('hidden', !isAuthenticated);
    }
    if (channelsTabBtn) {
        channelsTabBtn.style.display = hasIdentity ? 'inline-flex' : 'none';
    }
    if (channelsTabPanel) {
        channelsTabPanel.style.display = hasIdentity ? '' : 'none';
    }

    const deployTabBtn = document.querySelector('[data-tab="publish"]');
    if (deployTabBtn) {
        deployTabBtn.textContent = isAuthenticated ? '🚀 Deploy' : '🔐 Sign in';
    }

    const unlockBtn = document.getElementById('unlock-wallet-btn');
    const registerBtn = document.getElementById('register-wallet-btn');
    if (unlockBtn) unlockBtn.classList.toggle('hidden', !state.localWalletExists);
    if (registerBtn) registerBtn.classList.toggle('hidden', state.localWalletExists);

    // The DM panel shows the Nostr address only. All of it is public material
    // supplied by the signing worker; the private key never reaches this thread.
    const nostrReachable = isAuthenticated && state.nostrEnabled !== false;
    updateDmNostrIdentity({
        npub: nostrReachable ? state.npub || null : null,
        enabled: state.nostrEnabled !== false
    });
    renderDmConnectionState(this.channelsService?.connectionState || 'idle', { peerLabel: this.dmPeerLabel?.() || '' });

    // An identity that is reachable at its npub subscribes the inbox, so an
    // inbound invitation arrives without the user having to send one first.
    // Removing the Nostr identity unsubscribes it again.
    if (nostrReachable && this.nostrDmSession && !this.nostrDmSession.started) {
        void this.nostrDmSession
            .start({ localAddress: state.address })
            .then(() => this.presenceService?.start({ localNostrPublicKey: state.nostrPublicKey }))
            .then(() => this.refreshContactList())
            .catch((error) => {
                this.log(`Nostr inbox unavailable: ${error.message}`);
            });
    } else if (!nostrReachable && this.nostrDmSession?.started) {
        this.nostrDmSession.stop();
        // Removing the Nostr identity also stops announcing presence.
        this.presenceService?.stop();
        void this.channelsService?.leaveChannel();
    }

    if (!isAuthenticated) {
        const activeTab = document.querySelector('.tab-btn.active');
        const activeName = activeTab?.getAttribute('data-tab');
        if (activeName === 'auth' || activeName === 'channels') {
            const browseTab = document.querySelector('[data-tab="browse"]');
            if (browseTab instanceof HTMLElement) browseTab.click();
        }
        if (this.channelsService?.currentChannel) {
            this.channelsService.leaveChannel();
        }
        this.nostrDmSession?.stop();

        // A locked wallet must not leave decrypted contact data behind in
        // long-lived main-thread state, and a pending invitation cannot be
        // acted on without an identity to answer with. Both are dropped, and
        // the list goes back to its locked state until the wallet is unlocked
        // again.
        this.dmContacts = [];
        this.dmInvitations?.clear();
        // Consent is a decision about a conversation, and the conversation is
        // over: a locked wallet starts from nobody approved and nobody refused.
        this.dmConsentedPeers?.clear();
        this.dmDeclinedPeers?.clear();
        renderInvitations([]);
        renderContactsLocked();
        return;
    }

    if (hasJustAuthenticated) {
        const identityTab = document.querySelector('[data-tab="auth"]');
        if (identityTab instanceof HTMLElement) {
            identityTab.click();
        }
    }
}

export async function loadRequiredLibraries() {
    this.log('Loading required libraries...');

    // Load WebTorrent only from the CDN endpoint requested for reliability.
    if (typeof WebTorrent === 'undefined') {
        await this.loadScript(WEBTORRENT_CDN_URL);
        this.log('WebTorrent library loaded');
    }

    // Load DOMPurify from local scripts folder
    if (typeof DOMPurify === 'undefined') {
        await this.loadScript('scripts/purify.min.js');
        this.log('DOMPurify library loaded');
    }

    // Verify libraries are available
    if (typeof WebTorrent === 'undefined') {
        throw new Error('Failed to load WebTorrent library');
    }

    if (typeof DOMPurify === 'undefined') {
        throw new Error('Failed to load DOMPurify library');
    }

    this.librariesLoaded = true;
    this.log('All required libraries loaded successfully');
}

export function loadScript(src, integrity = null, crossorigin = null) {
    return new Promise((resolve, reject) => {
        // Check if script is already loaded
        const existingScript = document.querySelector(`script[src="${src}"]`);
        if (existingScript) {
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;

        // Add SRI integrity check if provided
        if (integrity) {
            script.integrity = integrity;
            this.log(`Adding integrity check: ${integrity.substring(0, 20)}...`);
        }

        // Add crossorigin attribute if provided
        if (crossorigin) {
            script.crossOrigin = crossorigin;
        }

        script.onload = () => {
            this.log(`Script loaded: ${src}`);
            resolve();
        };

        script.onerror = (_error) => {
            this.log(`Failed to load script: ${src}`);
            if (integrity) {
                this.log('Integrity check may have failed. Trying without integrity...');
                // Fallback: try loading without integrity check
                script.integrity = '';
                script.crossOrigin = '';
            }
            reject(new Error(`Failed to load script: ${src}`));
        };

        // Add to head
        document.head.appendChild(script);

        // Fallback timeout
        let loaded = false;
        const originalOnload = script.onload;
        script.onload = (...args) => {
            loaded = true;
            if (originalOnload) {
                /** @type {Function} */ (originalOnload).apply(script, args);
            }
        };
        setTimeout(() => {
            if (!loaded) {
                reject(new Error(`Script load timeout: ${src}`));
            }
        }, PEERWEB_CONFIG.SCRIPT_LOAD_TIMEOUT);
    });
}

export async function initializeWebTorrent() {
    if (!this.librariesLoaded) {
        throw new Error('Libraries not loaded yet');
    }

    return new Promise((resolve) => {
        try {
            const browserTrackers = (this.trackers || []).filter((trackerUrl) =>
                this.isBrowserSupportedTracker(trackerUrl)
            );
            if (browserTrackers.length === 0) {
                this.log(
                    '[WebTorrent] WARN: No browser-friendly trackers configured. Falling back to DHT/local peers only.'
                );
            } else {
                this.log(`[WebTorrent] Browser trackers enabled: ${browserTrackers.length}`);
            }
            this.client = new WebTorrent({
                tracker: {
                    announce: browserTrackers
                },
                rtcConfig: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                        { urls: 'stun:stun2.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ],
                    iceCandidatePoolSize: 10
                }
            });
            this.log('[WebTorrent] rtcConfig initialized (STUN + iceCandidatePoolSize=10)');

            this.client.on('error', (err) => {
                this.log('WebTorrent error: ' + err.message);
                console.error('WebTorrent error:', err);
            });

            this.client.on('ready', () => {
                this.clientReady = true;
                this.log('WebTorrent client ready');
                resolve();
            });

            // Fallback in case ready event doesn't fire
            setTimeout(() => {
                if (!this.clientReady) {
                    this.clientReady = true;
                    this.log('WebTorrent client ready (timeout fallback)');
                    resolve();
                }
            }, 2000);
        } catch (error) {
            this.log('Error initializing WebTorrent: ' + error.message);
            console.error('WebTorrent initialization error:', error);
            // Create a mock client to prevent crashes
            this.client = {
                add: () => console.error('WebTorrent not available'),
                seed: () => console.error('WebTorrent not available')
            };
            resolve();
        }
    });
}

export function isBrowserSupportedTracker(trackerUrl) {
    if (!trackerUrl || typeof trackerUrl !== 'string') {
        return false;
    }

    const normalized = trackerUrl.trim().toLowerCase();
    return normalized.startsWith('wss://') || normalized.startsWith('https://');
}

export function setupEventListeners() {
    // Debug toggle
    const debugToggle = document.getElementById('debug-toggle');
    if (debugToggle) {
        debugToggle.addEventListener('click', () => {
            this.toggleDebug();
        });
    }

    // Clear cache
    const clearCache = document.getElementById('clear-cache');
    if (clearCache) {
        clearCache.addEventListener('click', () => {
            this.clearCache();
        });
    }

    // Create torrent
    const createTorrent = document.getElementById('create-torrent');
    if (createTorrent) {
        createTorrent.addEventListener('click', () => {
            this.showTorrentModal();
        });
    }

    // Load site
    const loadSite = document.getElementById('load-site');
    if (loadSite) {
        loadSite.addEventListener('click', () => {
            const hashInput = /** @type {HTMLInputElement} */ (document.getElementById('hash-input'));
            const hash = hashInput.value.trim();
            if (hash) {
                this.loadSite(hash);
            }
        });
    }

    // Hash input enter key
    const hashInput = /** @type {HTMLInputElement} */ (document.getElementById('hash-input'));
    if (hashInput) {
        hashInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const target = /** @type {HTMLInputElement} */ (e.target);
                const hash = target.value.trim();
                if (hash) {
                    this.loadSite(hash);
                }
            }
        });
    }

    // Back to PeerWeb
    const backButton = document.getElementById('back-to-peerweb');
    if (backButton) {
        backButton.addEventListener('click', () => {
            this.showMainContent();
        });
    }

    // Close debug panel
    const closeDebug = document.getElementById('close-debug');
    if (closeDebug) {
        closeDebug.addEventListener('click', () => {
            document.getElementById('debug-panel').classList.add('hidden');
        });
    }

    // Modal controls
    const closeModal = document.getElementById('close-modal');
    if (closeModal) {
        closeModal.addEventListener('click', () => {
            this.hideTorrentModal();
        });
    }

    // File input
    const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file-input'));
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            this.handleFileSelection(e);
        });
    }

    // Create torrent button
    const createTorrentBtn = document.getElementById('create-torrent-btn');
    if (createTorrentBtn) {
        createTorrentBtn.addEventListener('click', () => {
            this.createTorrent();
        });
    }

    // Copy URL
    const copyUrl = document.getElementById('copy-url');
    if (copyUrl) {
        copyUrl.addEventListener('click', () => {
            const url = document.getElementById('created-url').textContent;
            navigator.clipboard.writeText(url);
            this.toast.success('You can now share this link with others!', 'URL Copied to Clipboard');
        });
    }

    // Setup drag and drop and quick upload
    this.setupDragAndDrop();
    this.setupQuickUpload();

    bindPublishActions({
        onSign: async () => {
            try {
                await this.signStagedPayload();
                this.toast.success('Payload signed and ready to deploy.', 'Signature ready');
            } catch (error) {
                updateDeployProgress({ label: error.message, percent: 100, state: 'error' });
                renderDeployStage('Signing failed', error.message);
                this.refreshDeployUiState();
                updateDeployWizard({
                    hasFiles: Boolean(this.pendingDeployFiles && this.pendingDeployFiles.length > 0),
                    hasSignature: false,
                    hasDeployResult: false,
                    isError: true
                });
                this.toast.error(error.message, 'Sign failed');
            }
        },
        onPublish: async () => {
            try {
                await this.deploySignedArtifact();
                this.toast.success('Deployment completed. Site is live and seeding.', 'Deploy complete');
            } catch (error) {
                updateDeployProgress({ label: error.message, percent: 100, state: 'error' });
                renderDeployStage('Deploy blocked', error.message);
                updateDeployWizard({
                    hasFiles: Boolean(this.pendingDeployFiles && this.pendingDeployFiles.length > 0),
                    hasSignature: Boolean(this.lastSignature && this.lastSignedPublish),
                    hasDeployResult: false,
                    isError: true
                });
                this.toast.error(error.message, 'Deploy failed');
            }
        }
    });
}

export function persistDeploySession() {
    if (!this.lastPublishCandidate?.hash || !this.lastSignature || !this.lastPublishCandidate?.signedTorrentFile) {
        return;
    }

    try {
        const signedBy = this.lastSignature?.payload?.publisherAddress || this.lastDeployResult?.signedBy || null;
        const payload = {
            hash: this.lastPublishCandidate.hash,
            siteName: this.lastPublishCandidate.siteName || 'website',
            createdAt: this.lastPublishCandidate.createdAt || null,
            signature: this.lastSignature,
            signedTorrentBase64: this.bytesToBase64(this.lastPublishCandidate.signedTorrentFile),
            deployed: Boolean(this.lastDeployResult),
            deployResult: this.lastDeployResult || null,
            signedBy,
            savedAt: Date.now()
        };
        localStorage.setItem(DEPLOY_SESSION_STORAGE_KEY, JSON.stringify(payload));
        this.log(`Deploy session saved for ${payload.hash}`);
    } catch (error) {
        this.log(`Failed to persist deploy session: ${error.message}`);
    }
}

export function clearDeploySession() {
    try {
        localStorage.removeItem(DEPLOY_SESSION_STORAGE_KEY);
    } catch (_) {}
}

export async function restoreDeploySession() {
    if (!this.clientReady || !this.client) return;

    let savedSession = null;
    try {
        const raw = localStorage.getItem(DEPLOY_SESSION_STORAGE_KEY);
        if (!raw) return;
        savedSession = JSON.parse(raw);
    } catch (error) {
        this.log(`Failed to parse deploy session: ${error.message}`);
        this.clearDeploySession();
        return;
    }

    if (!savedSession?.hash || !savedSession?.signature || !savedSession?.signedTorrentBase64) {
        this.clearDeploySession();
        return;
    }

    if (savedSession.savedAt && Date.now() - savedSession.savedAt > DEPLOY_SESSION_MAX_AGE_MS) {
        this.log('Deploy session expired, clearing.');
        this.clearDeploySession();
        return;
    }

    try {
        const signedTorrentBytes = this.base64ToBytes(savedSession.signedTorrentBase64);
        const signedTorrentBuffer = signedTorrentBytes.buffer.slice(
            signedTorrentBytes.byteOffset,
            signedTorrentBytes.byteOffset + signedTorrentBytes.byteLength
        );

        this.lastSignature = savedSession.signature;
        this.lastSignedPublish = attachPublishMetadata(savedSession.hash, savedSession.signature);
        this.lastPublishCandidate = {
            hash: savedSession.hash,
            siteName: savedSession.siteName || 'website',
            createdAt: savedSession.createdAt || new Date().toISOString(),
            signedTorrentFile: signedTorrentBuffer
        };
        this.lastDeployResult = savedSession.deployResult || null;
        renderSignatureStatus(this.lastSignature);
        renderPublishReview(this.lastSignature.payload || null);
        renderDeployStage(
            savedSession.deployed ? 'Deployment restored' : 'Signature restored',
            savedSession.deployed
                ? 'Reconnected to previous signed deployment after refresh'
                : 'Signed bundle restored. You can deploy now.'
        );

        await new Promise((resolve, reject) => {
            this.client.add(signedTorrentBytes, { announce: this.trackers }, (torrent) => {
                this.lastPublishCandidate.torrent = torrent;
                this.lastPublishCandidate.torrentFile = signedTorrentBuffer;

                if (savedSession.deployed) {
                    const url = `${window.location.origin}${window.location.pathname}?orc=${savedSession.hash}`;
                    this.lastDeployResult = savedSession.deployResult || {
                        hash: savedSession.hash,
                        url,
                        signedBy: savedSession.signedBy || this.lastSignature?.payload?.publisherAddress || 'Unknown'
                    };
                    this.showUploadResult(savedSession.hash, signedTorrentBuffer, torrent);
                    this.renderDeploymentSummary({
                        hash: savedSession.hash,
                        url: this.lastDeployResult.url,
                        signedBy: this.lastDeployResult.signedBy,
                        signature: this.lastSignature.signature,
                        signatureStatus: 'VERIFIED'
                    });
                }
                resolve();
            });

            setTimeout(() => reject(new Error('Timed out while restoring deploy session')), 12000);
        });

        this.refreshDeployUiState();

        if (this.lastPublishCandidate) {
            const deployWall = document.getElementById('deploy-auth-wall');
            const deployPanel = document.getElementById('deploy-panel');
            if (deployWall) deployWall.classList.add('hidden');
            if (deployPanel) deployPanel.classList.remove('hidden');
        }

        this.toast.info('Signed torrent session restored after refresh.', 'Session restored');
        this.log(`Deploy session restored for ${savedSession.hash}`);
    } catch (error) {
        this.log(`Failed to restore deploy session: ${error.message}`);
        this.clearDeploySession();
    }
}

export function bytesToBase64(value) {
    const uint8 = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
}

export function base64ToBytes(base64Value) {
    const binary = atob(base64Value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function calculateProcessingTimeout(torrent) {
    const sizeMB = torrent.length / (1024 * 1024);
    const fileCount = torrent.files.length;

    // Base timeout + additional time based on size and file count
    let timeout = PEERWEB_CONFIG.PROCESSING_TIMEOUT_BASE;
    timeout += sizeMB * PEERWEB_CONFIG.PROCESSING_TIMEOUT_PER_MB;
    timeout += fileCount * PEERWEB_CONFIG.PROCESSING_TIMEOUT_PER_FILE;

    // Clamp to min/max
    timeout = Math.max(PEERWEB_CONFIG.PROCESSING_TIMEOUT_MIN, timeout);
    timeout = Math.min(PEERWEB_CONFIG.PROCESSING_TIMEOUT_MAX, timeout);

    return Math.floor(timeout);
}

export function calculateFileTimeout(file) {
    const sizeMB = file.length / (1024 * 1024);

    let timeout = PEERWEB_CONFIG.FILE_TIMEOUT_BASE;
    timeout += sizeMB * PEERWEB_CONFIG.FILE_TIMEOUT_PER_MB;

    // Clamp to min/max
    timeout = Math.max(PEERWEB_CONFIG.FILE_TIMEOUT_MIN, timeout);
    timeout = Math.min(PEERWEB_CONFIG.FILE_TIMEOUT_MAX, timeout);

    return Math.floor(timeout);
}

export function clearInMemoryStreamingState({ resetDeploySession = false } = {}) {
    if (this.lastPublishCandidate?.torrent?.destroy) {
        try {
            this.lastPublishCandidate.torrent.destroy();
        } catch (_) {}
    }

    this.currentSiteData = null;
    this.currentHash = null;
    this.lastSignedPublish = null;
    this.lastSignature = null;
    this.lastPublishCandidate = null;
    this.lastDeployResult = null;
    this.signedTorrentMetadata.clear();
    this.currentSiteSignatureStatus = { label: 'Publisher: unverified', verified: false };
    this.revokeAllObjectURLs();
    this.channelsService?.leaveChannel?.();

    this.sendToServiceWorker('SITE_UNLOADED', {});
    this.showMainContent();

    if (resetDeploySession) {
        this.clearDeploySession();
    }
}

export async function clearCache(options = {}) {
    const { includeMemoryState = true, resetDeploySession = false } = options;
    await this.cache.clear();
    if (includeMemoryState) {
        this.clearInMemoryStreamingState({ resetDeploySession });
    }
    this.log('Cache cleared');
    this.toast.success(
        'All cached sites and in-memory streaming state have been removed.',
        'Cache Cleared Successfully'
    );
}
