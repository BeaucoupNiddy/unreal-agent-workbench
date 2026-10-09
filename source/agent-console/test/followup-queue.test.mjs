import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { ConsoleInputs } from '../console-inputs.mjs';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const classSource = source.slice(source.indexOf('class SessionBridge {'), source.indexOf('\nasync function createSession'));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, root) {
  root ||= await mkdtemp(path.join(tmpdir(), 'followup-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = new ConsoleInputs(root), calls = [], events = [], steers = [];
  const steering = { outcome: 'injected' };
  class HydraConnection {
    async connect() {}
    request(method, params) {
      if (method === 'session/attach') return Promise.resolve({ configOptions: [] });
      if (method === '_session/steering') {
        steers.push(params);
        return steering.error ? Promise.reject(new Error(steering.error)) : Promise.resolve({ outcome: steering.outcome });
      }
      assert.equal(method, 'session/prompt');
      return new Promise((resolve, reject) => calls.push({ params, resolve, reject }));
    }
    notify(method) { events.push({ kind: method }); }
    close() {}
  }
  class TurnHistory {
    turns = [];
    async load() {}
    start() { const turn = { startedAt: Date.now() }; this.turns.push(turn); return turn; }
    finish() {}
    snapshot() { return []; }
  }
  const context = { HydraConnection, TurnHistory, turnHistoryDir: root, bridges: new Map(), path, randomUUID,
    consoleInputs: inputs, hydraDir: root, autoTitles: {}, shouldGenerateAfterPrompt: () => false,
    recoverProvisionalTitle: async () => {}, readModelFavorites: async () => [],
    setInterval: () => 1, clearInterval() {}, setTimeout: () => ({ unref() {} }), clearTimeout() {} };
  const Bridge = vm.runInNewContext(`${classSource}\nSessionBridge`, context);
  const response = { write(frame) { events.push(JSON.parse(frame.split('\ndata: ')[1])); }, end() {} };
  const bridge = new Bridge('chat', response);
  t.after(() => bridge.stop());
  await bridge.start();
  const accept = (id, text = id, attachments = []) => bridge.acceptInput(text, attachments, id);
  const finish = async (index, stopReason = 'end_turn') => {
    const id = calls[index].params._meta['unreal-agent/input-id'];
    calls[index].resolve({ stopReason });
    const deadline = Date.now() + 3000;
    while (bridge.inputRequests.has(id)) {
      assert.ok(Date.now() < deadline, 'prompt should retire after durable completion');
      await tick();
    }
    await bridge.inputLock;
  };
  return { root, bridge, inputs, calls, events, steers, steering, accept, finish };
}

test('busy follow-ups are durable FIFO, never concurrent prompts until promoted', async t => {
  const { accept, calls, inputs, bridge, finish } = await setup(t);
  await accept('first');
  const image = [{ mimeType: 'image/png', data: 'YWJj' }];
  await Promise.all([accept('second', 'second', image), accept('third')]);
  assert.equal(calls.length, 1);
  assert.deepEqual((await inputs.pending('chat')).map(i => i.delivery), ['sending', 'queued', 'queued']);
  assert.deepEqual(bridge.queuedInputs.map(i => i.inputId), ['second', 'third']);
  await finish(0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params._meta['unreal-agent/input-id'], 'second');
  assert.equal(calls[1].params.prompt[1].data, 'YWJj');
  await finish(1);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].params._meta['unreal-agent/input-id'], 'third');
  await finish(2);
  assert.equal(bridge.activePrompts, 0);
  assert.deepEqual(await inputs.pending('chat'), []);
});

test('Steer now hands the queued item to the running turn through Hydra steering, not a queued prompt', async t => {
  const { accept, calls, inputs, bridge, finish, events, steers } = await setup(t);
  await accept('first'); await accept('second'); await accept('third', 'third', [{ mimeType: 'image/png', data: 'YWJj' }]);
  assert.equal((await bridge.steerInput('third')).delivery, 'steered');
  assert.equal(calls.length, 1, 'no second session/prompt waits behind the running turn');
  assert.equal(steers.length, 1);
  assert.equal(steers[0].sessionId, 'chat');
  assert.deepEqual(JSON.parse(JSON.stringify(steers[0].prompt)), [{ type: 'text', text: 'third' }, { type: 'image', mimeType: 'image/png', data: 'YWJj' }]);
  assert.equal(steers[0]._meta.steering.idleBehavior, 'promptRequired');
  assert.equal(events.some(e => e.kind === 'session/cancel'), false);
  assert.deepEqual([...bridge.queuedInputs.map(i => i.inputId)], ['second']);
  assert.equal((await inputs.pending('chat')).some(i => i.inputId === 'third'), false);
  const echo = events.find(e => e.params?.update?.sessionUpdate === 'user_message_chunk');
  assert.equal(echo.params.update.content.text, 'third', 'the sender sees its steered message');
  assert.equal((await bridge.steerInput('third')).delivery, 'sending', 'a repeat click is a no-op');
  assert.equal(steers.length, 1);
  await finish(0); assert.equal(calls.length, 2);
  assert.equal(calls[1].params._meta['unreal-agent/input-id'], 'second');
  await finish(1);
});

test('a message sent with steer delivery while busy reaches the running turn at once', async t => {
  const { accept, calls, bridge, inputs, steers, finish } = await setup(t);
  await accept('first');
  assert.equal((await bridge.acceptInput('change direction', [], 'steer-1', 'steer')).delivery, 'steered');
  assert.equal(calls.length, 1);
  assert.equal(steers[0].prompt[0].text, 'change direction');
  assert.deepEqual((await inputs.pending('chat')).map(i => i.inputId), ['first']);
  assert.equal((await bridge.acceptInput('later', [], 'queue-1', 'queue')).delivery, 'queued');
  assert.equal(steers.length, 1, 'queue delivery waits for the turn to end');
  await finish(0); assert.equal(calls.length, 2); await finish(1);
});

test('steering falls back to a normal send when the turn just ended, and to the queue when it fails', async t => {
  const { accept, calls, bridge, steering, finish, events } = await setup(t);
  await accept('first');
  steering.outcome = 'promptRequired';
  assert.equal((await bridge.acceptInput('idle now', [], 'idle-1', 'steer')).delivery, 'sending');
  assert.equal(calls.length, 2);
  steering.error = 'agent went away';
  assert.equal((await bridge.acceptInput('keep me', [], 'fail-1', 'steer')).delivery, 'queued');
  assert.deepEqual([...bridge.queuedInputs.map(i => i.inputId)], ['fail-1']);
  assert.ok(events.some(e => e.kind === 'queue_error'));
  await assert.rejects(bridge.steerInput('fail-1'), /still queued/);
  assert.deepEqual([...bridge.queuedInputs.map(i => i.inputId)], ['fail-1']);
  await finish(0); await finish(1); assert.equal(calls.length, 3); await finish(2);
});

test('retries are idempotent and reject different content, and queued messages can be removed', async t => {
  const { accept, calls, inputs, bridge, finish } = await setup(t);
  await accept('first'); await accept('second'); await accept('second');
  assert.equal(bridge.queuedInputs.length, 1);
  await assert.rejects(accept('second', 'different'), /different content/);
  await assert.rejects(accept('first', 'different'), /different content/);
  await bridge.removeQueuedInput('second');
  assert.equal((await inputs.pending('chat')).length, 1);
  await finish(0); assert.equal(calls.length, 1);
});

test('Stop discards queued messages and cannot auto-start them on cancellation', async t => {
  const { accept, calls, inputs, bridge, finish } = await setup(t);
  await accept('first'); await accept('second');
  await bridge.cancelInputs();
  await assert.rejects(accept('third'), /stopping/);
  await finish(0, 'cancelled');
  assert.equal(calls.length, 1);
  assert.equal(bridge.queuedInputs.length, 0);
  assert.deepEqual(await inputs.pending('chat'), []);
});

test('errors keep the remaining queue paused; Send now resumes without losing messages', async t => {
  const { accept, calls, bridge, finish } = await setup(t);
  await accept('first'); await accept('second'); await accept('third');
  calls[0].reject(new Error('provider unavailable')); await tick();
  assert.equal(calls.length, 1);
  assert.equal(bridge.queuedInputs.length, 2);
  await bridge.steerInput('second'); assert.equal(calls.length, 2);
  await finish(1); assert.equal(calls.length, 3); await finish(2);
});

test('restart replays in-flight IDs but keeps queued inputs out of the active runner; ready includes queue', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'followup-recover-'));
  const inputs = new ConsoleInputs(root);
  await inputs.save('chat', 'active', 'active', [], 'sending');
  await inputs.save('chat', 'queued', 'queued', [], 'queued');
  const { bridge, calls, events, finish } = await setup(t, root);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params._meta['unreal-agent/input-id'], 'active');
  assert.equal(events.find(e => e.queuedInputs)?.queuedInputs[0].inputId, 'queued');
  assert.equal(bridge.queuedInputs.length, 1);
  await finish(0); assert.equal(calls.length, 2); await finish(1);
});

test('a send racing natural completion starts normally instead of leaving an idle queue', async t => {
  const { accept, calls, finish, bridge } = await setup(t);
  await accept('first'); await finish(0);
  await accept('second');
  assert.equal(calls.length, 2); assert.equal(bridge.queuedInputs.length, 0); await finish(1);
});

test('a queue-only restart starts one item, then drains the rest in order', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'followup-idle-recover-'));
  const inputs = new ConsoleInputs(root);
  await inputs.save('chat', 'one', 'one', [], 'queued');
  await inputs.save('chat', 'two', 'two', [], 'queued');
  const { bridge, calls, finish } = await setup(t, root);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params._meta['unreal-agent/input-id'], 'one');
  assert.equal(bridge.queuedInputs[0].inputId, 'two');
  await finish(0); assert.equal(calls.length, 2); await finish(1);
});

test('a joining viewer gets the authoritative queue without submitting another prompt', async t => {
  const { accept, calls, bridge } = await setup(t);
  await accept('active'); await accept('queued');
  const frames = [];
  const viewer = { write(frame) { frames.push(frame); }, end() {} };
  await bridge.reconnect(viewer);
  const ready = JSON.parse(frames.find(frame => frame.startsWith('event: ready')).split('\ndata: ')[1]);
  assert.equal(ready.queuedInputs[0].inputId, 'queued');
  assert.equal(ready.activePrompts, 1);
  assert.equal(calls.length, 1);
});

test('remove racing natural delivery cannot remove or cancel a message that has started', async t => {
  const { accept, calls, bridge, finish } = await setup(t);
  await accept('active'); await accept('queued'); await finish(0);
  await assert.rejects(bridge.removeQueuedInput('queued'), /already started/);
  await bridge.steerInput('queued');
  assert.equal(calls.length, 2, 'the racing steer must not submit again');
  await finish(1);
});
