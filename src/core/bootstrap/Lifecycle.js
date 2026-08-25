// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';
import AuthController from '../../auth/AuthController.js';
import {
    bindPublishActions,
    renderDeployArtifactDetails,
    renderDeployStage,
    renderDeploymentStatus,
    setPublishButtonsState
} from '../../ui/publish/PublishPanel.js';
import { renderPublishReview } from '../../ui/publish/PublishReviewModal.js';
import { renderSignatureStatus } from '../../ui/publish/SignatureStatus.js';
import { attachPublishMetadata } from '../../torrent/TorrentPublishService.js';
import { createTorrentChainArtifact } from '../../torrent/TorrentChainProtocol.js';
import { encodeSiteBundleGzip, SITE_BUNDLE_FILE_NAME, SITE_BUNDLE_SCHEMA, supportsNativeGzipStreams } from '../../torrent/SiteBundleCodec.js';
import { hideDeployProgress, updateDeployProgress } from '../../ui/publish/DeployProgress.js';
import { initDeployWizard, updateDeployWizard } from '../../ui/publish/DeployWizard.js';
import {
    bindCategoryPicker,
    bindNosnsRetry,
    renderNosnsRelayStatus,
    renderNosnsStatus,
    renderNosnsTechnicalDetails,
    setCategoryFrozen,
    showSelectedCategory
} from '../../ui/publish/NosnsStatus.js';
import {
    bindNosnsPanel,
    filterNosnsResults,
    renderNosnsQueryStatus,
    renderNosnsResults,
    selectedBrowseCategory,
    showBrowseMode
} from '../../ui/browse/NosnsPanel.js';
import { NosNSService } from '../../nosns/NosNSService.js';
import { NOSNS_DEFAULT_CATEGORY, NOSNS_RELAY, dtanCategoryLabel, normalizeDtanCategory } from '../../nosns/NosNSProtocol.js';
import ChannelsService from '../../channels/ChannelsService.js';
import { NostrDirectMessageSession } from '../../channels/NostrDirectMessageSession.js';
import { NostrRelayPool } from '../../nostr/NostrRelayPool.js';
import { verifyNostrEvent, normalizeNostrPublicKey, npubEncode, shortNpub } from '../../nostr/nostr.js';
import { lookupNostrProfile } from '../../nostr/NostrProfileLookup.js';
import { DEFAULT_NOSTR_DM_RELAYS } from '../../config/nostr.config.js';
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
import { bindContactsPanel, bindSaveContact, renderContacts, renderSearchPresence } from '../../ui/channels/ContactsPanel.js';
import { NostrPresenceService, INTENT } from '../../channels/NostrPresenceService.js';
import { filterContacts, listContacts, saveContact } from '../../channels/ContactsStore.js';

const DEPLOY_SESSION_STORAGE_KEY = 'web25.deploy.session.v1';
/**
 * The chosen DTAN category, kept in its own key.
 *
 * The deploy session only exists once a payload has been signed, but the
 * category is picked before that — so a refresh between picking and signing
 * would otherwise silently reset it. Public directory metadata only.
 */
const NOSNS_CATEGORY_STORAGE_KEY = 'web25.nosns.category.v1';
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
    this.setupNosns();
}

/**
 * NosNS — the public WEB25 website directory over DTAN (NIP-35 kind 2003),
 * kept entirely separate from the Direct Messenger's private Nostr traffic:
 * its own relay, its own service, and only public metadata on the wire.
 */
export function setupNosns() {
    this.nosnsService = new NosNSService({ signer: this.dmSigner || createLocalWalletSigner() });
    this.registryPublication = null;
    this.lastRegistryEvent = null;
    /** Category chosen for the deployment being prepared. */
    this.nosnsCategory = this.restoreNosnsCategory();
    /** Query results per DTAN category, so switching back does not re-query. */
    this.nosnsResultCache = new Map();
    this.registryResults = [];
    this.nosnsBrowseCategory = NOSNS_DEFAULT_CATEGORY;
    /** NosNS entry a pending load came from, checked against .torrentchain. */
    this.pendingRegistryClaim = null;
    this.lastRegistryClaimComparison = null;

    bindNosnsRetry(() => void this.retryNosnsPublish());
    // The taxonomy is local configuration, so the picker is usable immediately
    // and stays usable whether or not the relay probe below succeeds.
    bindCategoryPicker((category) => this.setNosnsCategory(category), this.nosnsCategory);

    bindNosnsPanel({
        onModeChange: (mode) => {
            if (mode === 'registry' && !this.nosnsResultCache.has(this.nosnsBrowseCategory)) {
                void this.searchNosns('', this.nosnsBrowseCategory);
            }
        },
        onSearch: (query, category) => void this.searchNosns(query, category),
        onCategoryChange: (category) => {
            this.nosnsBrowseCategory = normalizeDtanCategory(category);
            void this.searchNosns('', this.nosnsBrowseCategory);
        },
        // Discovery hands the infohash to the one existing loader; there is no
        // second website loading path. The claim travels with it so the loader
        // can check it against the .torrentchain that actually arrives.
        onOpen: (infohash) => {
            this.pendingRegistryClaim = this.registryResults.find((entry) => entry.infohash === infohash) || null;
            this.loadSite(infohash);
        },
        initialCategory: this.nosnsBrowseCategory
    });
    showBrowseMode('hash');

    // Probe early so the Deploy tab can say whether the directory is reachable
    // before anyone spends a signature on it. A failure here is informational:
    // it never blocks staging, signing or deploying.
    void this.probeNosnsRelay();
}

/**
 * Report reachability of the one NosNS directory relay.
 *
 * This is connectivity only. Categories are mirrored configuration and load
 * regardless, so the two are never reported as one fact.
 */
export async function probeNosnsRelay() {
    renderNosnsRelayStatus({ relay: NOSNS_RELAY, reachable: null });
    try {
        const status = await this.nosnsService.probe();
        this.nosnsRelayReachable = status.reachable;
        renderNosnsRelayStatus({ relay: status.relay, reachable: status.reachable, error: status.error || null });
    } catch (error) {
        this.nosnsRelayReachable = false;
        renderNosnsRelayStatus({ relay: NOSNS_RELAY, reachable: false, error: error.message });
    }
}

/**
 * Record the DTAN category for the deployment being prepared.
 *
 * The category is directory metadata only: it is not part of `.torrentchain`
 * and never triggers a second EVM signature. Once the NosNS event is signed it
 * is frozen, so a retry resubmits the very same event.
 *
 * @param {string} category
 */
export function setNosnsCategory(category) {
    if (this.lastRegistryEvent) {
        showSelectedCategory(this.nosnsCategory);
        setCategoryFrozen(true);
        return;
    }
    this.nosnsCategory = normalizeDtanCategory(category);
    showSelectedCategory(this.nosnsCategory);
    try {
        localStorage.setItem(NOSNS_CATEGORY_STORAGE_KEY, this.nosnsCategory);
    } catch (error) {
        this.log(`Failed to persist NosNS category: ${error.message}`);
    }
    this.persistDeploySession();
}

/**
 * Read back the category chosen before a refresh.
 *
 * A stored value is re-validated against the taxonomy rather than trusted, so
 * an edited or stale key cannot put an unknown category into a signed event.
 *
 * @returns {string}
 */
export function restoreNosnsCategory() {
    try {
        const stored = localStorage.getItem(NOSNS_CATEGORY_STORAGE_KEY);
        return stored ? normalizeDtanCategory(stored) : NOSNS_DEFAULT_CATEGORY;
    } catch (_) {
        return NOSNS_DEFAULT_CATEGORY;
    }
}

/**
 * Query the NosNS directory for one DTAN category and render the results.
 *
 * The relay is asked for a category and nothing else — no NIP-50 full-text
 * search — and the text match is applied locally afterwards.
 *
 * @param {string} query
 * @param {string} [category]
 */
export async function searchNosns(query, category) {
    const tcat = normalizeDtanCategory(category || this.nosnsBrowseCategory || selectedBrowseCategory());
    this.nosnsBrowseCategory = tcat;

    const label = dtanCategoryLabel(tcat);
    const cached = this.nosnsResultCache.get(tcat);

    if (!cached) renderNosnsQueryStatus(`Querying ${label} on relay.dtan.xyz…`, 'pending');

    try {
        const results = cached || (await this.nosnsService.query({ category: tcat }));
        this.nosnsResultCache.set(tcat, results);
        this.registryResults = results;

        const filtered = filterNosnsResults(results, query);
        renderNosnsResults(filtered);

        const connected = this.nosnsService.relayStatus.filter((entry) => entry.status === 'connected').length;
        const total = this.nosnsService.relayStatus.length;
        renderNosnsQueryStatus(
            `${filtered.length} NosNS site${filtered.length === 1 ? '' : 's'} in ${label} · ${connected}/${total} directory relay reachable`,
            'ok'
        );
    } catch (error) {
        // Directory trouble never touches the hash-loading path next to it.
        this.registryResults = [];
        renderNosnsResults([]);
        renderNosnsQueryStatus(`NosNS unavailable: ${error.message}. Loading by hash still works.`, 'error');
    }
}

/**
 * Publish the finished deployment to the NosNS directory.
 *
 * Runs only after the deployment is already successful, and can never
 * invalidate it: a failure here is reported as a NosNS failure and leaves the
 * site live and seeding.
 */
export async function publishNosnsEntry() {
    const candidate = this.lastPublishCandidate;
    const signature = this.lastSignature;
    if (!candidate?.torrent || !signature?.signature) return;

    const category = normalizeDtanCategory(this.nosnsCategory);

    let npub = null;
    try {
        const identity = await this.nosnsService.signer.getNostrIdentity();
        npub = identity?.npub || null;
    } catch (_) {
        npub = null;
    }

    this.registryPublication = null;
    renderNosnsStatus({ state: 'signing', npub, category, title: candidate.torrent?.name || null });
    renderDeployStage('NosNS · building event', 'Creating the NIP-35 kind 2003 event for this torrent');
    updateDeployProgress({ label: 'Creating NIP-35 NosNS event', percent: 25, state: 'running' });
    this.refreshDeployUiState();

    try {
        // One signed event per artifact: built once here, reused verbatim by
        // every retry so a resubmission is never a second torrent entry.
        updateDeployProgress({ label: 'Signing NosNS event with your Nostr identity', percent: 55, state: 'running' });
        this.lastRegistryEvent = await this.nosnsService.createSignedNosnsEvent({
            torrent: candidate.torrent,
            chainArtifact: signature,
            siteName: candidate.siteName,
            trackers: this.trackers,
            category
        });
        // The category is now inside a signed event; it cannot change for this
        // deployment without producing a different event.
        setCategoryFrozen(true);
    } catch (error) {
        this.lastRegistryEvent = null;
        this.registryPublication = { ok: false, error: error.message, accepted: [], rejected: {}, attempted: 0, eventId: null };
        renderNosnsStatus({ state: 'skipped', npub, error: error.message, category });
        renderNosnsTechnicalDetails({ event: null, publication: this.registryPublication, category });
        // The site is deployed and seeding regardless of what happened here.
        renderDeployStage('Deployment complete', `Live and seeding · NosNS entry not created: ${error.message}`);
        updateDeployProgress({ label: 'Live and seeding · NosNS skipped', percent: 100, state: 'success' });
        this.refreshDeployUiState();
        return;
    }

    renderNosnsStatus({ state: 'publishing', npub, category, title: candidate.torrent?.name || null });
    renderNosnsTechnicalDetails({ event: this.lastRegistryEvent, publication: null, category });
    renderDeployStage('NosNS · publishing', 'Sending the signed event to relay.dtan.xyz');
    updateDeployProgress({ label: 'Publishing to the NosNS directory relay', percent: 80, state: 'running' });

    await this.sendNosnsEvent(npub);
}

/**
 * Send (or resend) the already-signed NosNS event.
 * @param {string|null} npub
 */
export async function sendNosnsEvent(npub = null) {
    const event = this.lastRegistryEvent;
    if (!event) return;

    const category = normalizeDtanCategory(this.nosnsCategory);
    const publication = await this.nosnsService.publishSignedEvent(event);
    this.registryPublication = publication;

    renderNosnsStatus({
        state: publication.ok ? 'published' : 'failed',
        accepted: publication.accepted,
        attempted: publication.attempted || this.nosnsService.relayStatus.length,
        error: publication.error,
        npub,
        eventId: publication.eventId,
        category,
        title: this.lastPublishCandidate?.torrent?.name || null
    });
    renderNosnsTechnicalDetails({
        event,
        publication,
        relayStatus: this.nosnsService.relayStatus,
        category
    });

    this.persistDeploySession();
    this.refreshDeployUiState();

    if (publication.ok) {
        // A fresh entry invalidates the cached page for that category.
        this.nosnsResultCache.delete(category);
        renderDeployStage(
            'Deployment complete',
            `Live and seeding · listed in NosNS under ${dtanCategoryLabel(category)}`
        );
        updateDeployProgress({ label: 'Live, seeding and discoverable', percent: 100, state: 'success' });
        this.toast.success(`Listed in the NosNS directory under ${dtanCategoryLabel(category)}.`, 'NosNS');
    } else {
        renderDeployStage('Deployment complete', 'Live and seeding · NosNS entry not published, retry available');
        updateDeployProgress({ label: 'Live and seeding · NosNS not published', percent: 100, state: 'success' });
        this.toast.warning(
            'Your site is live and seeding. The NosNS entry did not publish — you can retry it.',
            'NosNS not published'
        );
    }
}

/** Resubmit the exact same signed event: same id, created_at, category and signature. */
export async function retryNosnsPublish() {
    if (!this.lastRegistryEvent) {
        this.toast.warning('There is no signed NosNS event to retry.', 'NosNS');
        return;
    }
    let npub = null;
    try {
        npub = (await this.nosnsService.signer.getNostrIdentity())?.npub || null;
    } catch (_) {
        npub = null;
    }
    renderNosnsStatus({ state: 'publishing', npub, category: normalizeDtanCategory(this.nosnsCategory) });
    await this.sendNosnsEvent(npub);
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
        onPresenceChange: () => this.refreshContactList(),
        onIntentChange: (peer, state) => this.handleIntentChange(peer, state),
        onMutualIntent: (peer) => void this.startMutualConversation(peer),
        onError: (error) => this.log(`Nostr presence: ${error.message}`)
    });
    this.nostrDmSession.onChatRequest = (peer) => {
        this.presenceService.receiveChatRequest(peer);
        return undefined;
    };
    this.dmContacts = [];
    this.dmContactFilter = '';
    this.dmSelectedPeer = '';

    bindContactsPanel({
        // Opening a contact expresses intent; it does not connect.
        onSelect: (contact) => void this.requestChatWith(contact.nostrPublicKey, contact.name),
        onFilter: (query) => {
            this.dmContactFilter = query;
            this.refreshContactList();
        }
    });
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

            const npub = npubEncode(nostrPublicKey);
            return { nostrPublicKey, npub, shortNpub: shortNpub(npub), profile };
        },
        onStartChat: async (result) => {
            const identity = this.authController.getActiveIdentity();
            if (!identity?.address) {
                this.toast.warning('Authenticate first to use Direct Messenger.', 'Authentication required');
                return false;
            }
            return this.requestChatWith(result.nostrPublicKey, result.profile?.displayName || result.profile?.name || '');
        },
        onLeave: async () => {
            await this.channelsService.leaveChannel();
            // Stay subscribed: leaving a conversation should not stop the user
            // being reachable at their npub.
            this.nostrDmSession?.clearPeer();
            if (this.dmSelectedPeer) this.presenceService?.clearIntent(this.dmSelectedPeer);
            this.dmSelectedPeer = '';
            this.dmOfferSessionId = null;
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
        if (event.type === 'transport' || event.type === 'connecting' || event.type === 'connected' ||
            event.type === 'disconnected' || event.type === 'peer-count') {
            return;
        }
        if (event.type === 'left') {
            clearChannelsMessages();
        } else if (event.type === 'message') {
            appendChannelsMessage(event.message, event.local === true);
        } else if (event.type === 'file-incoming' || event.type === 'file-progress') {
            appendFileTransfer({ fileId: event.fileId, fileName: event.fileName, fileSize: event.fileSize || 0, received: event.received || 0 });
        } else if (event.type === 'file-ready') {
            appendFileTransfer({ fileId: event.fileId, fileName: event.fileName, fileSize: 0, received: 0, url: event.url });
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
            // An offer is not consent. Anyone can address this npub, so an
            // invitation from somebody the local user has not selected is
            // recorded as intent and left there — no answer, no handshake.
            const sender = `${context.senderNostrPublicKey}`.toLowerCase();
            if (this.presenceService && this.presenceService.intentState(sender) !== INTENT.MUTUAL) {
                this.presenceService.receiveChatRequest(sender);
                this.log(`Holding a Direct Messenger invitation from ${sender}: intent is not mutual yet.`);
                return;
            }

            // An open conversation is not interrupted by an unsolicited third
            // party either.
            const boundPeer = this.nostrDmSession.peerNostrPublicKey;
            if (this.channelsService.currentChannel && boundPeer && boundPeer !== sender) {
                this.log(`Ignoring a Direct Messenger invitation from ${sender} during an active session.`);
                return;
            }

            const derivedRoom = directMessageRoomFromSession(bootstrap.session.sessionId);
            const offerPayload = {
                description: bootstrap.webrtc.description,
                evmAddress: bootstrap.from.evmAddress,
                publicKey: bootstrap.from.eciesPublicKey
            };
            const answerSignal = await this.channelsService.createAnswerPayloadFromRemoteOffer(derivedRoom, offerPayload, identity);
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
            this.toast.success('Encrypted invitation accepted; connecting…', 'Direct Messenger');
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

/** Short label for whoever the current conversation is with. */
export function dmPeerLabel() {
    const peer = this.dmSelectedPeer;
    if (!peer) return '';
    const contact = (this.dmContacts || []).find((entry) => entry.nostrPublicKey === peer);
    if (contact?.name) return contact.name;
    return `${peer.slice(0, 8)}…`;
}

/** Reload contacts from IndexedDB and repaint the list with live presence. */
export async function refreshContactList() {
    try {
        this.dmContacts = await listContacts();
    } catch (error) {
        this.log(`Contacts unavailable: ${error.message}`);
        this.dmContacts = [];
    }

    // Watch exactly the contacts on screen; presence for anyone else is noise.
    this.presenceService?.watch(this.dmContacts.map((contact) => contact.nostrPublicKey));

    renderContacts(filterContacts(this.dmContacts, this.dmContactFilter), {
        isOnline: (pubkey) => Boolean(this.presenceService?.isOnline(pubkey)),
        selectedKey: this.dmSelectedPeer
    });
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
        await this.nostrDmSession.start({ localAddress: identity.address });
        this.dmSelectedPeer = `${nostrPublicKey}`.toLowerCase();
        this.dmPendingContactName = suggestedName;

        const state = await this.presenceService.sendChatRequest(this.dmSelectedPeer, (peer, kind, content) =>
            this.nostrDmSession.sendGiftWrapped(peer, kind, content)
        );

        renderSearchPresence(this.presenceService.isOnline(this.dmSelectedPeer));
        await this.refreshContactList();

        if (state === INTENT.MUTUAL) {
            // They had already asked; this completes the pair.
            this.toast.success('Both of you want to talk — connecting…', 'Direct Messenger');
            return true;
        }

        this.channelsService.setPreConnectionState('awaiting-peer');
        renderDmConnectionState('awaiting-peer', { peerLabel: this.dmPeerLabel() });
        this.toast.info('Request sent. The chat opens once they select you too.', 'Direct Messenger');
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
export function handleIntentChange(peer, state) {
    if (state === INTENT.RECEIVED && peer !== this.dmSelectedPeer) {
        // Somebody asked for us. Surfacing it is as far as this goes — the
        // local user still has to select them before anything is negotiated.
        this.toast.info('Someone would like to chat. Search or select them to accept.', 'Chat request');
    }
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
        await saveContact({
            nostrPublicKey: peer,
            npub: npubEncode(peer),
            // The EVM address is known only once an invitation was verified.
            evmAddress: this.channelsService.peerAddress || null,
            name
        });
        await this.refreshContactList();
        this.toast.success('Contact saved locally.', 'Contacts');
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
    updateDeployWizard({
        hasFiles,
        hasSignature,
        hasDeployResult: Boolean(this.lastDeployResult),
        registryState: this.nosnsStateLabel()
    });
}

/** @returns {'idle'|'publishing'|'published'|'failed'|'skipped'} */
export function nosnsStateLabel() {
    if (!this.registryPublication) return this.lastRegistryEvent ? 'publishing' : 'idle';
    if (this.registryPublication.ok) return 'published';
    // No event id means the event was never created — nothing was published and
    // nothing can be retried, which is a different outcome from a failed send.
    return this.registryPublication.eventId ? 'failed' : 'skipped';
}

export function invalidateSignedState(message = 'Signature invalidated') {
    this.lastSignature = null;
    this.lastSignedPublish = null;
    this.clearDeploySession();

    // A new artifact means a new NosNS event, so the category is editable again
    // and the previous signed event is no longer retryable.
    this.lastRegistryEvent = null;
    this.registryPublication = null;
    setCategoryFrozen(false);

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
        try { this.lastPublishCandidate.torrent.destroy(); } catch (_) {}
    }

    const inMemoryFiles = await this.buildInMemoryDeployBundle(this.pendingDeployFiles, ({ label, percent }) =>
        updateDeployProgress({ label, percent, state: 'running' })
    );

    const usingGzipBundle = PEERWEB_CONFIG.SITE_BUNDLE_MODE === 'gzip' && supportsNativeGzipStreams;
    let deployPayloadFiles = inMemoryFiles;
    let bundleMetadata = null;

    if (PEERWEB_CONFIG.SITE_BUNDLE_MODE === 'gzip' && !supportsNativeGzipStreams) {
        this.log('Gzip bundle mode requested but CompressionStream/DecompressionStream is unavailable. Falling back to files mode.');
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
        deployPayloadFiles = [this.createVirtualBundleFile(SITE_BUNDLE_FILE_NAME, encodedBundle.gzipBytes, 'application/gzip')];
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
    renderDeployArtifactDetails({
        payload: signature.payload,
        signature,
        bundleMode: usingGzipBundle ? 'gzip' : 'files'
    });

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
    renderDeploymentStatus('seeding');
    updateDeployProgress({ label: 'Seeding live', percent: 100, state: 'success' });
    renderDeployStage('Deployment complete', 'Live and seeding from memory');
    this.refreshDeployUiState();

    // The deployment is already complete and valid at this point. NosNS
    // publication is a separate, best-effort outcome: it is awaited only so the
    // UI can report it, and it can never unwind the deploy above.
    try {
        await this.publishNosnsEntry();
    } catch (error) {
        this.log(`NosNS publication failed: ${error.message}`);
    }
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
        return;
    }

    if (hasJustAuthenticated) {
        const identityTab = document.querySelector('[data-tab=\"auth\"]');
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
            const browserTrackers = (this.trackers || []).filter((trackerUrl) => this.isBrowserSupportedTracker(trackerUrl));
            if (browserTrackers.length === 0) {
                this.log('[WebTorrent] WARN: No browser-friendly trackers configured. Falling back to DHT/local peers only.');
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
    return (
        normalized.startsWith('wss://') ||
        normalized.startsWith('https://')
    );
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
            // The signed NIP-35 event, so a retry after a reload resubmits the
            // very same event rather than minting a second registry entry.
            // Public metadata only — it carries no key material of any kind.
            registryEvent: this.lastRegistryEvent || null,
            registryPublication: this.registryPublication || null,
            nosnsCategory: normalizeDtanCategory(this.nosnsCategory),
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
        // Restore the signed NosNS event so Retry resubmits it unchanged.
        this.lastRegistryEvent = savedSession.registryEvent || null;
        this.registryPublication = savedSession.registryPublication || null;
        this.nosnsCategory = normalizeDtanCategory(savedSession.nosnsCategory || this.nosnsCategory);
        showSelectedCategory(this.nosnsCategory);
        if (this.lastRegistryEvent) {
            // The category is inside a signed event again, so it re-freezes.
            setCategoryFrozen(true);
            renderNosnsStatus({
                state: this.registryPublication?.ok ? 'published' : 'failed',
                accepted: this.registryPublication?.accepted || [],
                attempted: this.registryPublication?.attempted || 0,
                error: this.registryPublication?.error || null,
                npub: null,
                eventId: this.lastRegistryEvent.id,
                category: this.nosnsCategory
            });
            renderNosnsTechnicalDetails({
                event: this.lastRegistryEvent,
                publication: this.registryPublication,
                category: this.nosnsCategory
            });
        }

        renderSignatureStatus(this.lastSignature);
        renderPublishReview(this.lastSignature.payload || null);
        renderDeployStage(
            savedSession.deployed ? 'Deployment restored' : 'Signature restored',
            savedSession.deployed
                ? 'Reconnected to previous signed deployment after refresh'
                : 'Signed bundle restored. You can deploy now.'
        );

        await new Promise((resolve, reject) => {
            this.client.add(
                signedTorrentBytes,
                { announce: this.trackers },
                (torrent) => {
                    this.lastPublishCandidate.torrent = torrent;
                    this.lastPublishCandidate.torrentFile = signedTorrentBuffer;

                    if (savedSession.deployed) {
                        const url = `${window.location.origin}${window.location.pathname}?orc=${savedSession.hash}`;
                        this.lastDeployResult =
                            savedSession.deployResult || {
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
                }
            );

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
    this.toast.success('All cached sites and in-memory streaming state have been removed.', 'Cache Cleared Successfully');
}
