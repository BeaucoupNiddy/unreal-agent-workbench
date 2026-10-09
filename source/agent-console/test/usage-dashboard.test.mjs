import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { subagentUsage, usageDashboard } from '../usage-dashboard.mjs';
import { saveAuxiliaryUsage } from '../../unreal-agent-acp/src/auxiliary-usage.mjs';

test('title and memory response usage remains included after its parent chat is gone', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dashboard-auxiliary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const event = { jobId: 'title-job', responseId: 'one', purpose: 'title', parentSessionId: 'deleted-chat', at: '2025-01-06T10:00:00Z',
    provider: 'openrouter', model: 'vendor/model', inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, cost: 0.02 };
  await saveAuxiliaryUsage(root, event); await saveAuxiliaryUsage(root, event);
  await saveAuxiliaryUsage(root, { ...event, jobId: 'memory-job', purpose: 'memory', inputTokens: 200, cost: 0.03 });
  const result = await usageDashboard([], { metadataDir: path.join(root, 'metadata'), auxiliaryDataDir: root, now: new Date('2025-01-07T00:00:00Z') });
  assert.equal(result.api.allTime.tokens, 340); assert.equal(result.api.allTime.cachedReadTokens, 100);
  assert.equal(result.api.allTime.dollars, 0.05); assert.equal(result.api.weeks[0].tokens, 340);
  assert.equal(result.api.purposes.title.tokens, 120);
  assert.equal(result.api.purposes.memory.tokens, 220);
  assert.equal(result.api.purposes.memory.dollars, 0.03);
  assert.equal(Object.values(result.api.purposes).reduce((total, bucket) => total + bucket.tokens, 0), result.api.allTime.tokens);
});

const id = (name) => `unreal-${name}`;
const session = (name) => ({ upstreamSessionId: id(name) });

test('separates subscription estimates from actual API charges, dates, models and undated history', async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'dashboard-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const save = async (name, provider, usage) => fs.writeFile(path.join(dir, `${createHash('sha256').update(id(name)).digest('hex')}.json`),
    JSON.stringify({ id: id(name), provider, usage }));
  await save('codex', 'openai-codex', { inputTokens: 1100, outputTokens: 120, cachedReadTokens: 125,
    events: [{ at: '2025-01-05T23:00:00Z', provider: 'openai-codex', model: 'gpt-5', inputTokens: 100, cachedReadTokens: 25, outputTokens: 20, cost: null },
      { at: '2025-01-06T01:00:00Z', provider: 'openai-codex', model: 'unknown', inputTokens: 1000, cachedReadTokens: 100, outputTokens: 100, cost: null }] });
  await save('claude', 'claude-code', { inputTokens: 300, outputTokens: 50, cachedReadTokens: 50,
    events: [{ at: '2025-01-06T10:00:00Z', provider: 'claude-code', model: 'claude-sonnet-4-6', inputTokens: 100, cachedReadTokens: 20, outputTokens: 50, cost: null, equivalent: 0.03 }] });
  await save('router', 'openrouter', { inputTokens: 400, outputTokens: 40, cachedReadTokens: 200,
    events: [{ at: '2025-01-06T10:00:00Z', provider: 'openrouter', model: 'openai/gpt-5', inputTokens: 400, cachedReadTokens: 200, outputTokens: 40, cost: 0.20 }] });
  await save('local', 'local-ollama', { inputTokens: 3000 });
  const result = await usageDashboard([session('codex'), session('codex'), session('claude'), session('router'), session('local'), session('deleted')],
    { metadataDir: dir, catalogFile: path.join(dir, 'missing'), now: new Date('2025-01-07T00:00:00Z') });
  assert.equal(result.subscriptions.allTime.tokens, 1370);
  assert.equal(result.subscriptions.purposes.main.tokens, 1370);
  assert.equal(result.subscriptions.earlierTokens, 200);
  assert.equal(result.subscriptions.earlierInputTokens, 200);
  assert.equal(result.subscriptions.earlierOutputTokens, 0);
  assert.equal(result.subscriptions.earlierCachedReadTokens, 30);
  assert.equal(result.subscriptions.allTime.inputTokens, 1200);
  assert.equal(result.subscriptions.allTime.outputTokens, 170);
  assert.equal(result.subscriptions.allTime.cachedReadTokens, 145);
  assert.equal(result.subscriptions.allTime.cachedReadTokens + result.subscriptions.earlierCachedReadTokens, 175);
  assert.equal(result.subscriptions.allTime.unpricedTokens, 1100);
  assert.ok(result.subscriptions.allTime.dollars > 0.03);
  assert.equal(result.subscriptions.weeks[0].start, '2025-01-06');
  assert.equal(result.subscriptions.weeks[0].tokens, 1250);
  assert.equal(result.subscriptions.weeks[0].inputTokens, 1100);
  assert.equal(result.subscriptions.weeks[0].outputTokens, 150);
  assert.equal(result.subscriptions.weeks[0].cachedReadTokens, 120);
  assert.equal(result.subscriptions.weeks[1].tokens, 120);
  assert.equal(result.subscriptions.weeks[1].cachedReadTokens, 25);
  assert.equal(result.subscriptions.months[0].tokens, 1370);
  assert.equal(result.subscriptions.months[0].cachedReadTokens, 145);
  assert.equal(result.subscriptions.allTime.models.length, 3);
  const unknown = result.subscriptions.allTime.models.find((model) => model.model === 'unknown');
  assert.deepEqual([unknown.inputTokens, unknown.outputTokens, unknown.cachedReadTokens], [1000, 100, 100]);
  assert.equal(result.api.allTime.tokens, 440);
  assert.deepEqual([result.api.allTime.inputTokens, result.api.allTime.outputTokens, result.api.allTime.cachedReadTokens], [400, 40, 200]);
  assert.equal(result.api.earlierCachedReadTokens, 0);
  assert.equal(result.api.weeks[0].cachedReadTokens, 200);
  assert.equal(result.api.allTime.models[0].cachedReadTokens, 200);
  assert.equal(result.api.allTime.dollars, 0.20);
  assert.equal(result.api.allTime.models[0].model, 'openai/gpt-5');
});


test('unlisted Codex cached reads use a clearly documented 10% assumption', async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'dashboard-cache-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const catalogFile = path.join(dir, 'catalog.json');
  await fs.writeFile(catalogFile, JSON.stringify({ models: [
    { value: 'openai/gpt-6-astra', description: '$2 in / $10 out per 1M tokens' }
  ] }));
  await fs.writeFile(path.join(dir, `${createHash('sha256').update(id('cached')).digest('hex')}.json`), JSON.stringify({
    id: id('cached'), provider: 'openai-codex', usage: { inputTokens: 100, outputTokens: 10,
      events: [{ at: '2025-01-06T10:00:00Z', provider: 'openai-codex', model: 'gpt-6-astra',
        inputTokens: 100, cachedReadTokens: 90, outputTokens: 10, cost: null }] }
  }));
  const result = await usageDashboard([session('cached')],
    { metadataDir: dir, catalogFile, now: new Date('2025-01-07T00:00:00Z') });
  assert.equal(result.subscriptions.allTime.tokens, 110);
  assert.equal(result.subscriptions.allTime.dollars, 0.000138);
  assert.equal(result.subscriptions.allTime.unpricedTokens, 0);
});

test('a Codex chat\'s API subagents count as API charges, by subagent', async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'dashboard-mixed-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const events = [
    { at: '2025-01-06T10:00:00Z', purpose: 'main', provider: 'openai-codex', model: 'gpt-5', inputTokens: 1000, outputTokens: 100, cost: null },
    { at: '2025-01-06T10:01:00Z', purpose: 'subagent', agent: 'researcher', provider: 'openrouter', model: 'vendor/model', inputTokens: 400, cachedReadTokens: 100, outputTokens: 40, cost: 0.25 },
    { at: '2025-01-06T10:02:00Z', purpose: 'subagent', agent: 'explorer', provider: 'openrouter', model: 'vendor/cheap', inputTokens: 200, outputTokens: 20, cost: 0.05 },
    { at: '2025-01-06T10:03:00Z', purpose: 'subagent', agent: 'reviewer', provider: 'claude-code', model: 'claude-sonnet-4-6', inputTokens: 300, outputTokens: 30, cost: null, equivalent: 0.04 }
  ];
  await fs.writeFile(path.join(dir, `${createHash('sha256').update(id('mixed')).digest('hex')}.json`),
    JSON.stringify({ id: id('mixed'), provider: 'openai-codex', usage: { inputTokens: 1900, outputTokens: 190, cachedReadTokens: 100, events } }));
  const result = await usageDashboard([session('mixed')], { metadataDir: dir, catalogFile: path.join(dir, 'missing'), now: new Date('2025-01-07T00:00:00Z') });
  assert.equal(result.api.allTime.dollars, 0.3);
  assert.equal(result.api.allTime.tokens, 660);
  assert.equal(result.api.purposes.subagent.dollars, 0.3);
  assert.deepEqual(Object.keys(result.api.agents).sort(), ['explorer', 'researcher']);
  assert.equal(result.api.agents.researcher.dollars, 0.25);
  assert.deepEqual(result.api.allTime.models.map((model) => model.provider), ['openrouter', 'openrouter']);
  assert.equal(result.subscriptions.allTime.tokens, 1430);
  assert.equal(result.subscriptions.agents.reviewer.dollars, 0.04);
  assert.equal(result.subscriptions.earlierTokens, 0);
  assert.equal(result.api.earlierTokens, 0);

  const chat = subagentUsage(events);
  assert.ok(Math.abs(chat.apiCost - 0.3) < 1e-12);
  assert.equal(chat.apiResponses, 2);
  assert.equal(chat.unpricedApiResponses, 0);
  assert.equal(chat.tokens, 990);
  assert.equal(chat.inputTokens, 900);
  assert.equal(subagentUsage([events[0]]), null);
  assert.equal(subagentUsage([{ ...events[1], cost: null }]).unpricedApiResponses, 1);
});
