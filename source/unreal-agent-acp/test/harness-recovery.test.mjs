import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UnrealAgentBridge, parseHarnessEvent } from '../src/bridge.mjs';
const fixture = fileURLToPath(new URL('./fixtures/mock-runner.mjs', import.meta.url));
const client = { notify: async () => {} };
async function setup(options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'harness-recovery-')));
  const bridge = new UnrealAgentBridge({ runner: fixture, dataDir: root, ...options });
  bridge.capabilityBroker = { start: async () => {}, warm() {}, closeSession() {}, close: async () => {} };
  const session = { id: `unreal-${randomUUID()}`, cwd: root, provider: 'fixture', model: 'test', thoughtLevel: 'low',
    permissionMode: 'danger-full-access', fullAccessApproved: true };
  bridge.sessions.set(session.id, session);
  return { root, bridge, session };
}

test('failed prompts recover saved inputs with their original IDs and deduplicate completed retries', async () => {
  const { root, bridge, session } = await setup();
  const id = randomUUID(), send = { sessionId: session.id, prompt: [{ type: 'text', text: 'recover this' }], _meta: { 'unreal-agent/input-id': id } };
  try {
    bridge.runPrompt = async () => { throw new Error('transport failed'); };
    await assert.rejects(bridge.prompt(send, client), /transport failed/);
    const saved = JSON.parse(await fs.readFile(bridge.sessionMetadataPath(session.id), 'utf8'));
    assert.equal(saved.pendingInputs[0].message_id, id);
    bridge.sessions.clear();
    await bridge.resumeSession({ sessionId: session.id, cwd: root });
    let launches = 0;
    bridge.runPrompt = async (_, __, ___, turn) => {
      launches++; turn.liveInput = false;
      assert.equal(turn.currentMessages[0].message_id, id);
      return { stopReason: 'end_turn' };
    };
    assert.equal((await bridge.prompt(send, client)).stopReason, 'end_turn');
    assert.equal((await bridge.prompt(send, client)).stopReason, 'end_turn');
    assert.equal(launches, 1);
    const done = JSON.parse(await fs.readFile(bridge.sessionMetadataPath(session.id), 'utf8'));
    assert.deepEqual(done.pendingInputs, []);
    assert.ok(done.completedInputIds.includes(id));
  } finally { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('missing or empty authoritative history refuses a resumed run before spawning', async () => {
  const { root, bridge, session } = await setup({ requireHarnessHistory: true });
  try {
    session.harnessStarted = true;
    await assert.rejects(bridge.prompt({ sessionId: session.id, prompt: [{ type: 'text', text: 'continue' }] }, client), /history is missing/);
    assert.equal(session.child, null);
  } finally { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('tool output retains all operations and reports a failing exit after a successful operation', () => {
  const [update] = parseHarnessEvent({ Kind: 'tool_call_status', Data: { CallID: 'batch', Operations: [
    { ID: 'one', Status: 'completed', State: { Result: { Out: 'success', ExitCode: 0 } } },
    { ID: 'two', Status: 'failed', State: { Result: { Err: 'failure detail', ExitCode: 7 } } }
  ] } });
  assert.match(update.output, /success/); assert.match(update.output, /failure detail/);
  assert.equal(update.exitCode, 7); assert.equal(update.status, 'failed');
  const [large] = parseHarnessEvent({ Kind: 'tool_call_status', Data: { CallID: 'batch', Operations: [
    { ID: 'one', Status: 'completed', State: { Result: { Out: 'first '.repeat(5000), ExitCode: 0 } } },
    { ID: 'two', Status: 'failed', State: { Result: { Err: 'second '.repeat(5000), ExitCode: 7 } } }
  ] } });
  assert.match(large.output, /\[one:/); assert.match(large.output, /\[two:/);
  assert.ok(large.output.length <= 12004);
});

test('age-based maintenance removes logs while preserving authoritative histories and attachments', async () => {
  const { root, bridge, session } = await setup();
  try {
    const history = path.join(root, 'sessions', 'old.session.jsonl');
    const image = path.join(root, 'sessions', 'attachments', 'old.png');
    const log = path.join(root, 'logs', 'old.log');
    const date = new Date(Date.now() - 40 * 86400_000);
    for (const file of [history, image, log]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'preserve'); await fs.utimes(file, date, date);
    }
    await bridge.prompt({ sessionId: session.id, prompt: [{ type: 'text', text: 'hello' }] }, client);
    assert.equal(await fs.readFile(history, 'utf8'), 'preserve');
    assert.equal(await fs.readFile(image, 'utf8'), 'preserve');
    await assert.rejects(fs.access(log), { code: 'ENOENT' });
  } finally { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); }
});
