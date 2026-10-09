import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BackgroundGenerator, runBackgroundModel } from '../background-generation.mjs';
import { readAuxiliaryUsage } from '../../unreal-agent-acp/src/auxiliary-usage.mjs';

const summary = '{"goal":"Preserve project decisions","outcome":"Done"}';
const prompt = (text) => JSON.stringify({ params: { update: { sessionUpdate: 'prompt_received', prompt: [{ type: 'text', text }] } } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'background-efficiency-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const historyFile = (id) => path.join(root, 'sessions', id, 'history.jsonl');
  const writeSession = async (id, text = 'Initial project decision') => {
    await fs.mkdir(path.dirname(historyFile(id)), { recursive: true });
    await fs.writeFile(path.join(path.dirname(historyFile(id)), 'meta.json'), JSON.stringify({ cwd: root }));
    await fs.writeFile(historyFile(id), prompt(text));
  };
  await writeSession('chat');
  const generator = new BackgroundGenerator({ hydraSessionRoot: path.join(root, 'sessions'), memoryRoot: path.join(root, 'memories'),
    oneOffWorkspace: path.join(root, 'oneoff'), debounceMs: 0, updateTitle: async () => {},
    readSettings: async () => ({ titleEnabled: true, memoryEnabled: true, titleModel: 'test', memoryModel: 'test' }), ...options });
  return { root, historyFile, writeSession, generator };
}

test('debounces bursts and reads the newest transcript only when the window closes', async (t) => {
  const requests = [];
  const { historyFile, generator } = await fixture(t, { debounceMs: 60, runModel: async (request) => { requests.push(request); return summary; } });
  const first = generator.afterPrompt('chat');
  await delay(25);
  await fs.appendFile(historyFile('chat'), '\n' + prompt('Newest filename decision'));
  const second = generator.afterPrompt('chat');
  assert.equal(first, second);
  await delay(40);
  assert.equal(requests.length, 0);
  await first;
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /Newest filename decision/);
});

test('changed history during inference gets a fresh summary without regenerating the title', async (t) => {
  const started = deferred(), release = deferred();
  t.after(() => release.resolve());
  const purposes = [], prompts = [], titles = [];
  const { historyFile, generator } = await fixture(t, { updateTitle: async (_, title) => titles.push(title),
    runModel: async (request) => {
      purposes.push(request.purpose); prompts.push(request.prompt);
      if (request.purpose === 'title') { started.resolve(); await release.promise; return 'Saved Project Title'; }
      return summary;
    } });
  const first = generator.afterPrompt('chat', { generateTitle: true });
  await started.promise;
  await fs.appendFile(historyFile('chat'), '\n' + prompt('Important changed decision'));
  const second = generator.afterPrompt('chat', { generateTitle: true });
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(purposes, ['title', 'memory', 'memory']);
  assert.deepEqual(titles, ['Saved Project Title']);
  assert.match(prompts.at(-1), /Important changed decision/);
  await generator.afterPrompt('chat');
  assert.equal(purposes.length, 3);
  // Persisted fingerprints survive a fresh generator/process.
  const restarted = new BackgroundGenerator({ ...generator, runModel: async () => assert.fail('unchanged memory must not regenerate') });
  await restarted.afterPrompt('chat');
});

test('background inference concurrency is capped across sessions and generator instances', async (t) => {
  const started = deferred(), release = deferred();
  t.after(() => release.resolve());
  let active = 0, maximum = 0, calls = 0;
  const runModel = async () => {
    calls++; active++; maximum = Math.max(active, maximum);
    if (calls === 2) started.resolve();
    await release.promise;
    active--; return summary;
  };
  const one = await fixture(t, { runModel });
  const two = await fixture(t, { runModel });
  await one.writeSession('other');
  const pending = [one.generator.afterPrompt('chat'), one.generator.afterPrompt('other'), two.generator.afterPrompt('chat')];
  await started.promise;
  await delay(20);
  assert.equal(calls, 2);
  release.resolve(); await Promise.all(pending);
  assert.equal(calls, 3); assert.equal(maximum, 2);
});

test('memory deduplication includes model and connection identity, not just text', async (t) => {
  let model = 'first', endpoint = 'http://localhost:8000/v1', calls = 0;
  const { root, generator } = await fixture(t, { readConnection: async () => ({ provider: 'local-test', model,
    environment: { UNREAL_HARNESS_LLM_BASE_URL: endpoint, UNREAL_HARNESS_LLM_API_KEY: 'secret-never-saved' } }),
    runModel: async () => { calls++; return summary; } });
  await generator.afterPrompt('chat'); await generator.afterPrompt('chat');
  model = 'second'; await generator.afterPrompt('chat');
  endpoint = 'http://localhost:9000/v1'; await generator.afterPrompt('chat');
  assert.equal(calls, 3);
  const record = await fs.readFile(path.join(root, 'memories', 'chat.json'), 'utf8');
  assert.doesNotMatch(record, /secret-never-saved|localhost/);
});

test('a failed runner still records completed response usage before deleting scratch logs', async (t) => {
  const { root } = await fixture(t);
  const script = path.join(root, 'failed-runner.mjs');
  await fs.writeFile(script, `console.log(JSON.stringify({Kind:'model_response',Data:{Response:{ID:'failed-response',Usage:{InputTokens:12,OutputTokens:3,Raw:{}},Output:[]}}})); process.exitCode=1;`);
  let scratch;
  await assert.rejects(runBackgroundModel({ runner: script, workspace: root, model: 'test', prompt: 'test', usageDataDir: root,
    purpose: 'memory', parentSessionId: 'chat', confinement: async ({ dataDir }) => { scratch = dataDir; return { command: process.execPath, args: [script] }; } }), /status 1/);
  const events = await readAuxiliaryUsage(root);
  assert.equal(events.length, 1); assert.equal(events[0].inputTokens, 12); assert.equal(events[0].cost, null);
  await assert.rejects(fs.stat(scratch), { code: 'ENOENT' });
});

test('disabled generation skips transcript and connection work entirely', async (t) => {
  const { generator, historyFile } = await fixture(t, {
    readSettings: async () => ({ titleEnabled: false, memoryEnabled: false }),
    readConnection: async () => assert.fail('disabled generation must not resolve connections'),
    runModel: async () => assert.fail('disabled generation must not call a model')
  });
  await fs.rm(historyFile('chat'));
  assert.deepEqual(await generator.afterPrompt('chat', { generateTitle: true }), { skipped: true });
});
