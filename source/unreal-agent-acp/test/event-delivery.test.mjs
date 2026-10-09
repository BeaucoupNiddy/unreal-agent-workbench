import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventDelivery } from '../src/event-delivery.mjs';

test('failed UI delivery survives bridge restart and replays each stable event ID in order', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'event-recovery-'));
  try {
    const offline = { notify: async () => { throw new Error('Disconnected'); } };
    const first = new EventDelivery(root);
    await first.enqueue('chat', 'session/update', { update: { text: 'one' } }, offline);
    await first.enqueue('chat', 'session/update', { update: { text: 'two' } }, offline);
    const events = [], online = { notify: async (_, params) => events.push(params) };
    await new EventDelivery(root).flush('chat', online);
    assert.deepEqual(events.map((value) => value.update.text), ['one', 'two']);
    assert.deepEqual(events.map((value) => value._meta['unreal-agent/event-id']), ['chat:1', 'chat:2']);
    await new EventDelivery(root).flush('chat', online);
    assert.equal(events.length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an incomplete final journal write is recovered without discarding committed events', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'event-tail-'));
  try {
    const delivery = new EventDelivery(root), events = [];
    await delivery.enqueue('chat', 'session/update', { update: { text: 'saved' } }, { notify: async () => { throw new Error('offline'); } });
    const state = await delivery.state('chat');
    await fs.appendFile(state.journal, '{"seq":2');
    const restarted = new EventDelivery(root);
    await restarted.flush('chat', { notify: async (_, value) => events.push(value) });
    assert.equal(events[0].update.text, 'saved');
    await restarted.enqueue('chat', 'session/update', { update: { text: 'new' } }, { notify: async (_, value) => events.push(value) });
    assert.equal(events[1]._meta['unreal-agent/event-id'], 'chat:2');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
