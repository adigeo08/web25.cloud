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
        seedPhrasePreview: null,
        passkeyProtected: false
    };
}
