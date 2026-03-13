// @ts-check

export const AUTH_STATUS = {
    ANONYMOUS: 'anonymous',
    EXTERNAL_CONNECTED: 'external_connected',
    LOCAL_REGISTERED_LOCKED: 'local_registered_locked',
    LOCAL_UNLOCKED: 'local_unlocked',
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
        seedPhrasePreview: null
    };
}
