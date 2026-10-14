/**
 * Message history kept on this device, per conversation, for at most a week.
 *
 * What these pin is the protection model, not the plumbing: nothing is kept
 * unless the conversation asked for it, what is kept is sealed to the wallet
 * and names nobody, it goes when its timestamp says so — whatever the peer
 * claims the time is — and a locked wallet can neither read nor add to it
 * while the purge still runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MessageArchive,
    MAX_RETENTION_MS,
    MESSAGES_DB_NAME,
    MESSAGES_STORE_NAME,
    MESSAGES_SETTINGS_STORE_NAME,
    conversationTag,
    normalizeRetention
} from '../src/channels/MessageArchive.js';
import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

const DAY = 24 * 60 * 60 * 1000;
const ALICE = nostrCore.getNostrPublicKey('22'.repeat(32));
const BOB = nostrCore.getNostrPublicKey('33'.repeat(32));

function makeWallet(privateKey = `0x${'11'.repeat(32)}`) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let counter = 0;
    const call = async (type, payload = {}) => {
        const response = await core.handle({ id: `m${++counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };
    return {
        unlock: () => core.handle({ id: 'unlock', type: WALLET_WORKER_OPS.UNLOCK, payload: { privateKey } }),
        lock: () => core.handle({ id: 'lock', type: WALLET_WORKER_OPS.LOCK }),
        signer: {
            getNostrIdentity: async () => call(WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY).catch(() => null),
            nostrEncrypt: async (plaintext, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext, peerPublicKey })).payload,
            nostrDecrypt: async (payload, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload, peerPublicKey })).plaintext
        }
    };
}

async function archiveAt(start = Date.parse('2026-10-14T12:00:00Z')) {
    const fake = installFakeIndexedDb();
    const wallet = makeWallet();
    await wallet.unlock();
    const clock = { now: start };
    const archive = new MessageArchive({ signer: wallet.signer, now: () => clock.now });
    return { fake, wallet, clock, archive };
}

const message = (id, text, at) => ({ id, from: '0xabc', text, timestamp: new Date(at).toISOString() });

test('a conversation keeps nothing until it is asked to', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        assert.equal(await archive.getRetention(ALICE), 0);
        assert.equal(await archive.record(ALICE, message('m1', 'hello', clock.now)), false);
        assert.deepEqual(fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME), []);
        assert.deepEqual(await archive.history(ALICE), []);
    } finally {
        fake.restore();
    }
});

test('a kept conversation comes back in order, with who wrote what', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, MAX_RETENTION_MS);
        await archive.record(ALICE, message('m2', 'second', clock.now - 1000), { own: true });
        await archive.record(ALICE, message('m1', 'first', clock.now - 5000));

        const history = await archive.history(ALICE);
        assert.deepEqual(
            history.map((m) => [m.id, m.text, m.own]),
            [
                ['m1', 'first', false],
                ['m2', 'second', true]
            ]
        );
    } finally {
        fake.restore();
    }
});

test('IndexedDB holds no text, no key and no address in the clear', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, DAY);
        await archive.record(ALICE, {
            id: 'm1',
            from: '0xfeedfacefeedface',
            text: 'the secret plan',
            timestamp: clock.now
        });

        const raw = JSON.stringify([
            ...fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME),
            ...fake.rawRows(MESSAGES_DB_NAME, MESSAGES_SETTINGS_STORE_NAME)
        ]);
        for (const secret of ['the secret plan', 'feedface', ALICE, '"m1"']) {
            assert.ok(!raw.includes(secret), `${secret} must not be stored in the clear`);
        }
        const [row] = fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME);
        assert.deepEqual(Object.keys(row).sort(), ['ciphertext', 'conversationTag', 'expiresAt', 'id', 'sentAt']);
    } finally {
        fake.restore();
    }
});

test('a message goes when its own timestamp plus the window has passed', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, DAY);
        await archive.record(ALICE, message('old', 'from yesterday morning', clock.now - 20 * 60 * 60 * 1000));
        await archive.record(ALICE, message('new', 'just now', clock.now));

        clock.now += 5 * 60 * 60 * 1000; // 25 h after the old one, 5 h after the new one
        const removed = await archive.purgeExpired();
        assert.equal(removed, 1);
        assert.deepEqual(
            (await archive.history(ALICE)).map((m) => m.id),
            ['new']
        );
    } finally {
        fake.restore();
    }
});

test('a peer cannot outlive the window by dating a message in the future', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, DAY);
        await archive.record(ALICE, message('future', 'from next year', clock.now + 365 * DAY));
        const [row] = fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME);
        assert.equal(row.sentAt, clock.now, 'the claimed time is clamped to now');
        assert.equal(row.expiresAt, clock.now + DAY);
    } finally {
        fake.restore();
    }
});

test('a message already older than the window is not kept at all', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, DAY);
        assert.equal(await archive.record(ALICE, message('stale', 'two days ago', clock.now - 2 * DAY)), false);
        assert.deepEqual(fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME), []);
    } finally {
        fake.restore();
    }
});

test('retention is capped at seven days, and anything unrecognised means off', async () => {
    assert.equal(normalizeRetention(30 * DAY), MAX_RETENTION_MS);
    assert.equal(normalizeRetention(-1), 0);
    assert.equal(normalizeRetention('nonsense'), 0);
    assert.equal(MAX_RETENTION_MS, 7 * DAY);

    const { fake, archive } = await archiveAt();
    try {
        assert.equal(await archive.setRetention(ALICE, 30 * DAY), MAX_RETENTION_MS);
        assert.equal(await archive.getRetention(ALICE), MAX_RETENTION_MS);
    } finally {
        fake.restore();
    }
});

test('turning it off deletes what was kept', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, DAY);
        await archive.record(ALICE, message('m1', 'hello', clock.now));
        await archive.setRetention(ALICE, 0);
        assert.deepEqual(fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME), []);
        assert.equal(await archive.getRetention(ALICE), 0);
    } finally {
        fake.restore();
    }
});

test('a shorter window re-dates what is kept, and drops what it no longer covers', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, MAX_RETENTION_MS);
        await archive.record(ALICE, message('three-days', 'old', clock.now - 3 * DAY));
        await archive.record(ALICE, message('an-hour', 'recent', clock.now - 60 * 60 * 1000));

        await archive.setRetention(ALICE, DAY);
        const rows = fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].expiresAt, clock.now - 60 * 60 * 1000 + DAY);
    } finally {
        fake.restore();
    }
});

test('the same message arriving twice is kept once', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, DAY);
        await archive.record(ALICE, message('dup', 'over WebRTC', clock.now));
        await archive.record(ALICE, message('dup', 'over WebRTC', clock.now));
        assert.equal(fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME).length, 1);
    } finally {
        fake.restore();
    }
});

test('conversations are kept apart, and settings are per conversation', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, DAY);
        await archive.record(ALICE, message('a1', 'to alice', clock.now));
        assert.equal(await archive.record(BOB, message('b1', 'to bob', clock.now)), false, 'Bob keeps nothing');
        assert.deepEqual(await archive.history(BOB), []);
        assert.deepEqual(
            (await archive.history(ALICE)).map((m) => m.text),
            ['to alice']
        );
        assert.notEqual(conversationTag(ALICE, BOB), conversationTag(BOB, ALICE));
    } finally {
        fake.restore();
    }
});

test('a locked wallet can neither read nor add, but the purge still runs', async () => {
    const { fake, wallet, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, DAY);
        await archive.record(ALICE, message('m1', 'kept', clock.now));
        await wallet.lock();

        await assert.rejects(() => archive.history(ALICE), /Unlock your wallet/);
        await assert.rejects(() => archive.record(ALICE, message('m2', 'more', clock.now)), /Unlock your wallet/);

        clock.now += 2 * DAY;
        assert.equal(await archive.purgeExpired(), 1, 'expiry needs no key');
        assert.deepEqual(fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME), []);
    } finally {
        fake.restore();
    }
});

test('another wallet in the same browser cannot read this one’s history', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, DAY);
        await archive.record(ALICE, message('m1', 'mine', clock.now));

        const other = makeWallet(`0x${'44'.repeat(32)}`);
        await other.unlock();
        const theirs = new MessageArchive({ signer: other.signer, now: () => clock.now });
        assert.deepEqual(await theirs.history(ALICE), []);
        assert.equal(await theirs.getRetention(ALICE), 0);
    } finally {
        fake.restore();
    }
});

test('forgetting a conversation removes its messages and its setting', async () => {
    const { fake, archive, clock } = await archiveAt();
    try {
        await archive.setRetention(ALICE, DAY);
        await archive.record(ALICE, message('m1', 'hello', clock.now));
        await archive.forget(ALICE);
        assert.deepEqual(fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME), []);
        assert.deepEqual(fake.rawRows(MESSAGES_DB_NAME, MESSAGES_SETTINGS_STORE_NAME), []);
    } finally {
        fake.restore();
    }
});

test('the archive lives in its own database and is handed a capability, never a key', async () => {
    assert.equal(MESSAGES_DB_NAME, 'web25-messages');
    const source = await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../src/channels/MessageArchive.js', import.meta.url), 'utf8')
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/privateKey|nsec|localStorage/.test(code));
    assert.ok(!/publish|relay/i.test(code), 'nothing here talks to the network');
});
