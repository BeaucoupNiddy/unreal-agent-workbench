// Offline end-to-end check: the compiled Go companion, real Bash process and
// production ACP bridge, with only provider inference replaced by local SSE.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UnrealAgentBridge } from '../src/bridge.mjs';
import { saveLocalProvider } from '../src/local-providers.mjs';
const binary = process.env.UNREAL_AGENT_LIVE_RUNNER || fileURLToPath(new URL('../runtime/unreal-agent-live-runner', import.meta.url));
const available = await fs.access(binary, 1).then(() => true, () => false);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 500; i++) { if (await fn()) return; await pause(10); }
  assert.fail('Integration condition timed out');
}

test('compiled companion steers while real Bash continues, then resumes the session', { skip: !available, timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'live-go-integration-'));
  const workspacePath = path.join(root, 'workspace');
  await fs.mkdir(workspacePath);
  const workspace = await fs.realpath(workspacePath);
  const requests = [];
  let inferenceError;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test' }, { id: 'next-model' }] }));
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      requests.push(request);
      const n = requests.length;
      let output;
      if (n === 1 || n === 5) {
        output = [{ type: 'function_call', id: 'fc-slow', call_id: 'slow-bash', name: 'Bash',
          arguments: JSON.stringify({ command: n === 1
            ? 'echo running > started.txt; while [ ! -f release.txt ]; do sleep 0.02; done; echo finished'
            : 'echo running > cancelling.txt; while [ ! -f cancel-release.txt ]; do sleep 0.02; done; echo leaked > after-cancel.txt' }), status: 'completed' }];
      } else {
        if (n === 2) {
          assert.equal(await fs.readFile(path.join(workspace, 'started.txt'), 'utf8'), 'running\n');
          assert.equal(await fs.access(path.join(workspace, 'release.txt')).then(() => true, () => false), false);
          assert.ok(JSON.stringify(request.input).includes('new direction now'));
          assert.ok(JSON.stringify(request.input).includes('Tool call is still running'));
        }
        output = [{ type: 'message', id: `msg-${n}`, role: 'assistant', phase: 'final_answer', status: 'completed',
          content: [{ type: 'output_text', text: n === 2 ? 'Steering received while Bash runs' : `Completed ${n}` }] }];
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
        id: `response-${n}`, status: 'completed', output,
        usage: { input_tokens: 30, output_tokens: 5, input_tokens_details: { cached_tokens: 10 } }
      } })}\n\n`);
    } catch (error) {
      inferenceError = error;
      res.writeHead(500); res.end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const envKeys = ['UNREAL_HARNESS_LLM_BASE_URL', 'UNREAL_HARNESS_LLM_API_KEY'];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.UNREAL_HARNESS_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.UNREAL_HARNESS_LLM_API_KEY = 'offline-test';
  const dataDir = path.join(root, 'data');
  const connection = await saveLocalProvider(dataDir, { type: 'custom', name: 'Offline test',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'offline-test' });
  const bridge = new UnrealAgentBridge({ dataDir });
  assert.equal(bridge.liveRunner, binary, "the verified companion is selected by default");
  bridge.capabilityBroker = { start: async () => {}, warm: () => {}, closeSession: () => {}, close: async () => {} };
  const session = { id: `unreal-${randomUUID()}`, cwd: workspace, provider: connection.id, model: 'test',
    localConnection: { id: connection.id, type: connection.type, name: connection.name, baseUrl: connection.baseUrl },
    localModels: [{ value: 'test', name: 'Test' }, { value: 'next-model', name: 'Next' }], thoughtLevel: 'low', mcpServers: [],
    // Nested sandbox-exec is denied when this suite runs inside the harness.
    // On a normal macOS terminal, exercise the actual workspace sandbox too.
    permissionMode: process.platform === 'darwin' && !process.env.UNREAL_AGENT_SESSION_ID ? 'workspace-write' : 'danger-full-access', fullAccessApproved: true };
  bridge.sessions.set(session.id, session);
  const updates = [];
  const client = { notify: async (_, { update }) => updates.push(update) };
  const send = (text) => bridge.prompt({ sessionId: session.id, prompt: [{ type: 'text', text }] }, client);
  const watchdog = setTimeout(() => { void bridge.cancel({ sessionId: session.id }); }, 20_000);
  watchdog.unref();
  let first, steering, initialError;
  try {
    first = send('start the long tool');
    // Attach rejection handlers immediately so setup failures are reported by
    // the assertions below, not by an unhandled-rejection side channel.
    first.catch((error) => { initialError = error; });
    await until(async () => initialError || await fs.access(path.join(workspace, 'started.txt')).then(() => true, () => false));
    if (initialError) throw initialError;
    const pid = session.child.pid;
    await assert.rejects(bridge.updateModel(session, 'next-model'), /Finish or stop/);
    await assert.rejects(bridge.setConfigOption({ sessionId: session.id, configId: 'permission_mode', value: 'read-only' }), /Finish or stop/);
    await bridge.setConfigOption({ sessionId: session.id, configId: 'thought_level', value: 'high' });
    await bridge.setConfigOption({ sessionId: session.id, configId: 'thought_level', value: 'high' });
    await assert.rejects(bridge.setConfigOption({ sessionId: session.id, configId: 'permission_mode', value: 'read-only' }), /Finish or stop/);
    steering = send('new direction now'); steering.catch(() => {});
    await until(() => inferenceError || updates.some((u) => u.content?.text === 'Steering received while Bash runs'));
    if (inferenceError) throw inferenceError;
    assert.equal(requests[1].model, 'test');
    assert.equal(requests[1].reasoning.effort, 'high');
    assert.equal(requests[1].reasoning.effort, 'high');
    assert.equal(session.child.pid, pid);
    assert.equal(session.child.exitCode, null);
    await fs.writeFile(path.join(workspace, 'release.txt'), 'done');
    for (const result of await Promise.all([first, steering])) assert.equal(result.stopReason, 'end_turn');
    assert.ok(updates.some((u) => u.rawOutput?.output?.includes('finished')));
    assert.equal(session.usage.responses.length, 3);
    assert.ok(session.usage.events.every((event) => event.model === 'test'));
    session.localModels = ['test', 'next-model'].map((value) => ({ value, name: value }));
    await bridge.updateModel(session, 'next-model');
    await bridge.persistSession(session);
    await bridge.closeSession({ sessionId: session.id });
    await bridge.resumeSession({ sessionId: session.id, cwd: workspace });
    assert.equal((await send('continue the previous task')).stopReason, 'end_turn');
    assert.ok(JSON.stringify(requests.at(-1).input).includes('new direction now'));
    assert.ok(JSON.stringify(requests.at(-1).input).includes('finished'));
    assert.equal(requests.length, 4);
    assert.equal(requests.at(-1).model, 'next-model');
    const cancelled = send('start a task to cancel'); cancelled.catch(() => {});
    await until(() => fs.access(path.join(workspace, 'cancelling.txt')).then(() => true, () => false));
    await bridge.cancel({ sessionId: session.id });
    assert.equal((await cancelled).stopReason, 'cancelled');
    // A leaked shell would exit its loop and write this file after release.
    await fs.writeFile(path.join(workspace, 'cancel-release.txt'), 'done');
    await pause(200);
    assert.equal(await fs.access(path.join(workspace, 'after-cancel.txt')).then(() => true, () => false), false);
  } finally {
    clearTimeout(watchdog);
    await bridge.cancel({ sessionId: session.id });
    await Promise.allSettled([first, steering].filter(Boolean));
    await bridge.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
