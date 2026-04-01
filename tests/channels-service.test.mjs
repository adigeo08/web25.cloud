import test from 'node:test';
import assert from 'node:assert/strict';
import ChannelsService from '../src/channels/ChannelsService.js';

function createMockTorrent() {
    const handlers = new Map();
    return {
        numPeers: 0,
        wires: [],
        on(event, cb) {
            handlers.set(event, cb);
        },
        emit(event, value) {
            const cb = handlers.get(event);
            if (cb) cb(value);
        },
        destroy(_opts, done) {
            done?.();
        }
    };
}

test('ChannelsService joins with existing trackers and emits joined state', async () => {
    const mockTorrent = createMockTorrent();
    let addArgs = null;
    const client = {
        add(magnet, opts) {
            addArgs = { magnet, opts };
            return mockTorrent;
        }
    };

    const service = new ChannelsService({ client, trackers: ['wss://existing-tracker.test'] });
    const events = [];
    service.onUpdate((event) => events.push(event));

    await service.joinChannel('Builders', { address: '0xabc' });

    assert.equal(service.currentChannel, 'builders');
    assert.match(addArgs.magnet, /magnet:\?xt=urn:btih:[a-f0-9]{40}/);
    assert.deepEqual(addArgs.opts.announce, ['wss://existing-tracker.test']);
    assert.equal(events.some((event) => event.type === 'joined'), true);
});

test('ChannelsService deduplicates repeated inbound messages', async () => {
    const mockTorrent = createMockTorrent();
    const client = { add() { return mockTorrent; } };
    const service = new ChannelsService({ client, trackers: [] });

    const received = [];
    service.onUpdate((event) => {
        if (event.type === 'message') received.push(event.message.id);
    });

    await service.joinChannel('Builders', { address: '0xabc' });

    const msg = {
        type: 'chat',
        id: 'm1',
        text: 'hello',
        channel: 'builders',
        from: '0xdef',
        timestamp: new Date().toISOString()
    };

    service.handleInbound(msg);
    service.handleInbound(msg);

    assert.deepEqual(received.filter((id) => id === 'm1').length, 1);
});

test('ChannelsService handleInbound marks remote messages as non-local (Fix 3 bug)', async () => {
    const mockTorrent = createMockTorrent();
    const client = { add() { return mockTorrent; } };
    const service = new ChannelsService({ client, trackers: [] });

    const events = [];
    service.onUpdate((event) => events.push(event));
    await service.joinChannel('test', {});

    // Simulate what ChannelsWireExtension.onMessage does after the fix:
    // it must pass false (not the wire object) as isLocal
    const msg = {
        type: 'chat',
        id: 'remote-1',
        text: 'from remote peer',
        channel: 'test',
        from: '0xremote',
        timestamp: new Date().toISOString()
    };
    service.handleInbound(msg, false);

    const msgEvent = events.find((e) => e.type === 'message' && e.message.id === 'remote-1');
    assert.ok(msgEvent, 'message event should be emitted');
    assert.equal(msgEvent.local, false, 'remote message must NOT be marked as local');
});

test('ChannelsService handleInbound passing a truthy wire object marks message as local (pre-fix behaviour)', async () => {
    const mockTorrent = createMockTorrent();
    const client = { add() { return mockTorrent; } };
    const service = new ChannelsService({ client, trackers: [] });

    const events = [];
    service.onUpdate((event) => events.push(event));
    await service.joinChannel('test', {});

    const msg = {
        type: 'chat',
        id: 'wire-1',
        text: 'bug demo',
        channel: 'test',
        from: '0xpeer',
        timestamp: new Date().toISOString()
    };
    // Passing a truthy wire object (the pre-fix behaviour) would mark it local=true
    const fakeWire = { extended: () => {} };
    service.handleInbound(msg, fakeWire);

    const msgEvent = events.find((e) => e.type === 'message' && e.message.id === 'wire-1');
    assert.ok(msgEvent, 'message event should be emitted');
    // The wire object is truthy so local ends up truthy (object reference, not strictly true)
    assert.ok(msgEvent.local, 'passing wire object results in truthy local — this was the bug');
});

test('ChannelsService emits presence event when presence message received (Fix 3)', async () => {
    const mockTorrent = createMockTorrent();
    const client = { add() { return mockTorrent; } };
    const service = new ChannelsService({ client, trackers: [] });

    const events = [];
    service.onUpdate((event) => events.push(event));
    await service.joinChannel('test', {});

    const presenceMsg = {
        type: 'presence',
        id: 'pres-1',
        channel: 'test',
        from: '0xpeer42',
        timestamp: new Date().toISOString()
    };
    service.handleInbound(presenceMsg, false);

    const presenceEvent = events.find((e) => e.type === 'presence');
    assert.ok(presenceEvent, 'presence event should be emitted');
    assert.equal(presenceEvent.from, '0xpeer42');

    const peerCountEvent = events.find((e) => e.type === 'peer-count');
    assert.ok(peerCountEvent, 'peer-count event should be emitted on presence');
});

test('ChannelsService deduplicates repeated presence messages', async () => {
    const mockTorrent = createMockTorrent();
    const client = { add() { return mockTorrent; } };
    const service = new ChannelsService({ client, trackers: [] });

    const presenceEvents = [];
    service.onUpdate((event) => {
        if (event.type === 'presence') presenceEvents.push(event);
    });
    await service.joinChannel('test', {});

    const presenceMsg = {
        type: 'presence',
        id: 'pres-dup',
        channel: 'test',
        from: '0xpeer',
        timestamp: new Date().toISOString()
    };
    service.handleInbound(presenceMsg, false);
    service.handleInbound(presenceMsg, false);

    assert.equal(presenceEvents.length, 1, 'presence should be deduplicated by id');
});

test('ChannelsService leaveChannel cancels any pending retry timeout', async () => {
    const mockTorrent = createMockTorrent();
    const client = { add() { return mockTorrent; } };
    const service = new ChannelsService({ client, trackers: [] });

    await service.joinChannel('test', {});

    // Inject a fake timeout to verify it gets cleared
    const fakeId = setTimeout(() => {}, 60000);
    service._retryTimeout = fakeId;

    await service.leaveChannel();

    // After leave, _retryTimeout must be null
    assert.equal(service._retryTimeout, null, '_retryTimeout should be cleared on leaveChannel');
    clearTimeout(fakeId); // clean up the fake timeout in case it wasn't cleared
});
