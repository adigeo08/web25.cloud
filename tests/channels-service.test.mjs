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
