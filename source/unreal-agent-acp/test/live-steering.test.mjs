import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnrealAgentBridge } from '../src/bridge.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures/live-steering-runner.mjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 300; i++) { if (await condition()) return; await pause(10); }
  assert.fail('Timed out waiting for live steering');
}
async function setup(options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'live-steering-test-'));
  const workspacePath = path.join(root, 'workspace');
  await fs.mkdir(workspacePath);
  const workspace = await fs.realpath(workspacePath);
  const bridge = new UnrealAgentBridge({ dataDir: path.join(root, 'data'), liveRunner: fixture, ...options });
  bridge.capabilityBroker = { start: async () => {}, warm: () => {}, closeSession: () => {}, close: async () => {} };
  const session = { id: `unreal-${randomUUID()}`, cwd: workspace, provider: 'offline-fixture', model: 'test',
    permissionMode: 'danger-full-access', fullAccessApproved: true, thoughtLevel: 'high', mcpServers: [] };
  bridge.sessions.set(session.id, session);
  const updates = [];
  const client = { notify: async (_method, { update }) => updates.push(update) };
  const send = (text) => bridge.prompt({ sessionId: session.id, prompt: [{ type: 'text', text }] }, client);
  const read = async (name) => fs.readFile(path.join(workspace, name), 'utf8').catch(() => '');
  const dispose = async () => {
    await bridge.cancel({ sessionId: session.id });
    await session.activeTurn?.promise.catch(() => {});
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  };
  return { bridge, session, workspace, updates, client, send, read, dispose };
}

test('live steering reaches the same process with multiple tools/messages still active', async () => {
  const f = await setup();
  try {
    const first = f.send('long tool');
    await until(async () => Boolean(await f.read('tool-active.txt')));
    const pid = f.session.child.pid;
    const second = f.send('change direction');
    const third = f.send('also keep the current tool');
    await until(() => f.updates.some((u) => u.content?.text === 'Live steering: also keep the current tool'));
    assert.equal(f.session.child.pid, pid);
    assert.equal(f.session.child.exitCode, null);
    assert.equal(await f.read('release-tool.txt'), '');
    assert.equal(await f.read('interrupted.txt'), '');
    const inputs = (await f.read('inputs.jsonl')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(inputs.map((m) => m.content), ['long tool', 'change direction', 'also keep the current tool']);
    assert.equal(new Set(inputs.map((m) => m.message_id)).size, 3);
    await fs.writeFile(path.join(f.workspace, 'release-tool.txt'), 'done');
    for (const result of await Promise.all([first, second, third])) assert.deepEqual(result, { stopReason: 'end_turn' });
    assert.equal((await f.read('launches.jsonl')).trim().split('\n').length, 1);
    assert.equal(f.session.child, null);
    assert.equal(f.session.activeTurn, null);
  } finally { await f.dispose(); }
});

test('messages submitted during startup are delivered live after spawning', async () => {
  const f = await setup();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started = false;
  f.bridge.capabilityBroker.start = async () => { started = true; await blocked; };
  try {
    const first = f.send('long tool');
    await until(() => started);
    const second = f.send('startup steering');
    await until(() => f.session.activeTurn.pendingSteers.length === 2);
    release();
    await until(() => f.updates.some((u) => u.content?.text === 'Live steering: startup steering'));
    assert.equal((await f.read('launches.jsonl')).trim().split('\n').length, 1);
    await fs.writeFile(path.join(f.workspace, 'release-tool.txt'), 'done');
    await Promise.all([first, second]);
  } finally { release(); await f.dispose(); }
});

test('a steer racing natural exit is replayed in the same session with the same UUID', async () => {
  const f = await setup();
  let steering, id;
  const original = f.client.notify;
  f.client.notify = async (...args) => {
    await original(...args);
    if (args[1].update.content?.text === 'closing now') {
      steering = f.send('do not lose this');
      await until(() => f.session.activeTurn.pendingSteers.some((m) => m.content === 'do not lose this'));
      id = f.session.activeTurn.pendingSteers.find((m) => m.content === 'do not lose this').message_id;
    }
  };
  try {
    assert.deepEqual(await f.send('exit race'), { stopReason: 'end_turn' });
    assert.deepEqual(await steering, { stopReason: 'end_turn' });
    const inputs = (await f.read('inputs.jsonl')).trim().split('\n').map(JSON.parse);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1].message_id, id);
    const launches = (await f.read('launches.jsonl')).trim().split('\n').map(JSON.parse);
    assert.equal(launches.length, 2);
    assert.equal(launches[0].session, launches[1].session);
  } finally { await f.dispose(); }
});

test('Stop cancels a live task and all sharing prompt requests without restarting', async () => {
  const f = await setup();
  try {
    const first = f.send('long tool');
    await until(async () => Boolean(await f.read('tool-active.txt')));
    const second = f.send('steer before stop');
    await until(() => f.updates.some((u) => u.content?.text === 'Live steering: steer before stop'));
    await f.bridge.cancel({ sessionId: f.session.id });
    for (const result of await Promise.all([first, second])) assert.equal(result.stopReason, 'cancelled');
    assert.equal((await f.read('launches.jsonl')).trim().split('\n').length, 1);
    assert.equal(f.session.activeTurn, null);
    assert.deepEqual(await f.send('fresh after cancellation'), { stopReason: 'end_turn' });
  } finally { await f.dispose(); }
});

test('an explicitly configured missing live runner fails clearly', async () => {
  const f = await setup({ liveRunner: '/nonexistent/unreal-live-runner' });
  try {
    await assert.rejects(f.send('hello'), /Live runner is unavailable/);
    assert.equal(f.session.activeTurn, null);
  } finally { await f.dispose(); }
});

test('persisted pending input recovers with its UUID and completed retries do not run again', async () => {
  const f = await setup();
  const recovered = new UnrealAgentBridge({ dataDir: f.bridge.dataDir, liveRunner: fixture });
  recovered.capabilityBroker = { start: async () => {}, warm: () => {}, closeSession: () => {}, close: async () => {} };
  const queuedId = randomUUID(), nextId = randomUUID();
  try {
    f.session.pendingInputs = [{ role: 'user', content: 'queued before bridge restart', message_id: queuedId }];
    await f.bridge.persistSession(f.session);
    await recovered.resumeSession({ sessionId: f.session.id, cwd: f.workspace });
    const send = (content, id) => recovered.prompt({ sessionId: f.session.id,
      prompt: [{ type: 'text', text: content }], _meta: { 'unreal-agent/input-id': id } }, f.client);
    assert.deepEqual(await send('next input after reconnect', nextId), { stopReason: 'end_turn' });
    const inputs = (await f.read('inputs.jsonl')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(inputs.map((m) => m.message_id), [queuedId, nextId]);
    assert.equal(recovered.sessions.get(f.session.id).pendingInputs.length, 0);
    assert.deepEqual(await send('next input after reconnect', nextId), { stopReason: 'end_turn' });
    assert.equal((await f.read('launches.jsonl')).trim().split('\n').length, 1);
  } finally { await recovered.close(); await f.dispose(); }
});

test('folder sandbox restart waits for active tools and withholds continuation from the old live process', async () => {
  // The fixtures run outside sandbox-exec (nested sandboxes are disallowed).
  // Folder approval/profile enforcement is covered in folder-access.test.mjs;
  // this checks the immutable-profile restart against real process events.
  const f = await setup();
  try {
    const running = f.send('long tool');
    await until(async () => Boolean(await f.read('tool-active.txt')));
    const pid = f.session.child.pid, turn = f.session.activeTurn;
    const continuation = { role: 'user', message_id: randomUUID(), content: 'Continue after folder write approval' };
    f.session.writableFolders = [path.join(f.workspace, 'granted')];
    f.session.pendingInputs.push(continuation);
    turn.folderContinuation = continuation;
    turn.folderRestart = true;
    turn.interruptRequested = true;
    await f.bridge.persistSession(f.session);
    await pause(40);
    assert.equal(f.session.child.pid, pid);
    assert.equal(f.session.child.exitCode, null);
    assert.equal(await f.read('interrupted.txt'), '');
    assert.ok(!(await f.read('inputs.jsonl')).includes(continuation.message_id));
    await fs.writeFile(path.join(f.workspace, 'release-tool.txt'), 'done');
    assert.deepEqual(await running, { stopReason: 'end_turn' });
    const launches = (await f.read('launches.jsonl')).trim().split('\n').map(JSON.parse);
    assert.equal(launches.length, 2);
    assert.equal(launches[0].session, launches[1].session);
    const inputs = (await f.read('inputs.jsonl')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(inputs.map(m => m.content), ['long tool', continuation.content]);
    assert.equal(inputs[1].message_id, continuation.message_id);
    assert.deepEqual(f.session.pendingInputs, []);
  } finally { await f.dispose(); }
});

test('Hydra steering requests reach the running turn at once and return without waiting for it', async () => {
  const f = await setup();
  try {
    assert.deepEqual((await f.bridge.initialize({ protocolVersion: 1 }))._meta, { steering: { supported: true } });
    assert.deepEqual(await f.bridge.steer({ sessionId: f.session.id, prompt: [{ type: 'text', text: 'too early' }] }),
      { outcome: 'promptRequired', reason: 'noRunningTurn' });
    const first = f.send('long tool');
    await until(async () => Boolean(await f.read('tool-active.txt')));
    const pid = f.session.child.pid;
    const result = await f.bridge.steer({ sessionId: f.session.id, prompt: [{ type: 'text', text: 'change direction' }] });
    assert.deepEqual(result, { outcome: 'injected' });
    await until(() => f.updates.some((u) => u.content?.text === 'Live steering: change direction'));
    assert.equal(f.session.child.pid, pid);
    assert.equal(await f.read('release-tool.txt'), '');
    await fs.writeFile(path.join(f.workspace, 'release-tool.txt'), 'done');
    assert.deepEqual(await first, { stopReason: 'end_turn' });
    const inputs = (await f.read('inputs.jsonl')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(inputs.map((m) => m.content), ['long tool', 'change direction']);
  } finally { await f.dispose(); }
});
