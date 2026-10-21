// @ts-check

export const AUTH_STATUS = {
    ANONYMOUS: 'anonymous',
    LOCAL_REGISTERED_LOCKED: 'local_registered_locked',
    LOCAL_UNLOCKED: 'local_unlocked',
    LOCAL_NEEDS_MIGRATION: 'local_needs_migration',
    PASSKEY_NOT_SUPPORTED: 'passkey_not_supported',
    SIGNING: 'signing',
    PUBLISHING: 'publishing'
};

export function createAuthState() {
    return {
        status: AUTH_STATUS.ANONYMOUS,
        identityType: null,
        address: null,
        chainId: 1,
        localWalletExists: false,
        localWalletUnlocked: false,
        // A wallet created in this page whose recovery phrase is on the backup
        // screen and not yet acknowledged. The worker may be unlocked, but the
        // user is not signed in until this is false: unlocked is not onboarded.
        seedBackupPending: false,
        // A wallet whose backup was never acknowledged before the page went
        // away. The phrase is gone for good; the sign-in wall offers a reset.
        seedBackupInterrupted: false,
        passkeyProtected: false,
        // Public secp256k1 key of the unlocked wallet, fetched from the signing
        // worker. Public material only — never the private key.
        publicKey: null,
        // The same key's Nostr view: x-only public key and its NIP-19 `npub`.
        // There is no `nsec` here, or anywhere else.
        nostrPublicKey: null,
        npub: null,
        // Whether this identity is reachable over Nostr. The key always exists
        // — this is the user's Add/Delete choice on the Identity page.
        nostrEnabled: true,
        // Where the user was before the page reloaded, and whether a session
        // was live then. Public breadcrumb only; see SessionResumeHint.js.
        resumeHint: null
    };
}