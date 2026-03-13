// @ts-check

let viemAccountsPromise;

export function loadViemAccounts() {
    if (!viemAccountsPromise) {
        viemAccountsPromise = import('https://esm.sh/viem@2.22.21/accounts');
    }
    return viemAccountsPromise;
}
