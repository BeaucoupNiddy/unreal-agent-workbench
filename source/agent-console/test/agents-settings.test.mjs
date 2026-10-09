import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addChoices, inheritModel, modelChoices, subagentPresets } from '../public/agents-settings.js';
import { normalizeAgentSettings } from '../../unreal-agent-acp/src/agent-profiles.mjs';
import { usageDashboard } from '../usage-dashboard.mjs';
import { saveAuxiliaryUsage } from '../../unreal-agent-acp/src/auxiliary-usage.mjs';

test('the five built-in subagents are valid profiles and only Tester and Worker can edit', () => {
  const presets = subagentPresets().map((preset) => inheritModel(preset, [], { provider: 'openai-codex', model: 'gpt-6-luna' }));
  const settings = normalizeAgentSettings({ enabled: true, subagents: presets });
  assert.deepEqual(settings.subagents.map((agent) => [agent.id, agent.access]),
    [['explorer', 'read-only'], ['researcher', 'read-only'], ['reviewer', 'read-only'], ['tester', 'workspace-write'], ['worker', 'workspace-write']]);
  assert.ok(settings.subagents.every((agent) => agent.instructions && agent.model === 'gpt-6-luna'));
});

test('new subagents copy the last subagent\'s provider and model, or the primary agent\'s', () => {
  const primary = { provider: 'openai-codex', model: 'gpt-6-astra' };
  assert.deepEqual(inheritModel({ name: 'New' }, [], primary), { name: 'New', provider: 'openai-codex', model: 'gpt-6-astra' });
  const existing = [{ provider: 'openai-codex', model: 'x' }, { provider: 'openrouter', model: 'vendor/model', thoughtLevel: 'high' }];
  assert.deepEqual(inheritModel({ name: 'Reviewer', thoughtLevel: 'low' }, existing, primary),
    { name: 'Reviewer', thoughtLevel: 'low', provider: 'openrouter', model: 'vendor/model' });
});

test('the add menu offers a blank subagent and presets not already added', () => {
  const choices = addChoices([{ name: ' reviewer ' }]);
  assert.deepEqual(choices.map((choice) => [choice.value, Boolean(choice.disabled)]),
    [['blank', false], ['Explorer', false], ['Researcher', false], ['Reviewer', true], ['Tester', false], ['Worker', false]]);
});

test('subagent model choices keep an unavailable saved model visible', () => {
  const providers = [{ id: 'openrouter', models: [{ value: 'a/b', name: 'B' }] }, { id: 'local-x', local: true, models: [] }];
  assert.deepEqual(modelChoices(providers, 'openrouter', 'gone/model').map((item) => item.value), ['', 'gone/model', 'a/b']);
  assert.equal(modelChoices(providers, 'local-x')[0].name, 'First available local model');
});

test('settings has an Agents tab for the primary agent and subagents, saved through /api/agents', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="agentsTab"[^>]*aria-controls="agentsPanel"/);
  const panel = html.slice(html.indexOf('id="agentsPanel"'), html.indexOf('id="generalPanel"'));
  for (const name of ['defaultProvider', 'defaultModel', 'defaultThoughtLevel', 'agentsEnabled', 'agentsMaxConcurrent']) assert.match(panel, new RegExp(`name="${name}"`));
  assert.match(panel, /id="subagentList"/);
  assert.match(app, /requestJson\("\/api\/agents", \{ method: "PUT"/);
  assert.match(server, /url\.pathname === "\/api\/agents"/);
});

test('subagent usage has its own dashboard purpose', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dashboard-subagent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveAuxiliaryUsage(root, { jobId: 'job', responseId: 'one', purpose: 'subagent', agent: 'explorer', at: '2025-01-06T10:00:00Z',
    provider: 'openrouter', model: 'vendor/model', inputTokens: 100, outputTokens: 20, cost: 0.01 });
  const result = await usageDashboard([], { metadataDir: path.join(root, 'metadata'), auxiliaryDataDir: root, now: new Date('2025-01-07T00:00:00Z') });
  assert.equal(result.api.purposes.subagent.tokens, 120);
});

test('the OpenRouter key can be entered in Settings and is never sent back to the page', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="openrouterKeyPanel"[\s\S]*type="password" id="openrouterKeyInput"/);
  assert.match(html, /id="agentsOpenrouterWarning"/);
  assert.match(app, /\$\("#openrouterKeyPanel"\)\.hidden = provider\?\.id !== "openrouter"/);
  assert.match(server, /url\.pathname === "\/api\/openrouter-key"/);
  assert.match(server, /json\(res, 200, \{ configured: Boolean\(await readOpenRouterKey\(\)\) \}\)/);
  assert.doesNotMatch(server, /json\([^)]*\bkey: /);
});

test('subagents can share one model, including when the five are added together', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="sameModelForAll"/);
  assert.match(html, /<dialog class="modal" id="subagentModelDialog"/);
  assert.match(app, /\$\("#addSubagentPresets"\)\.addEventListener\("click", \(\) => openSubagentModelDialog\("add"\)\)/);
  assert.match(app, /applyModelToCards\(\$\("#subagentList"\), choice\.provider, choice\.model\)/);
});
