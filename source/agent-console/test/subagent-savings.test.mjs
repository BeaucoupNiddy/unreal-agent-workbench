import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { subagentSavings } from '../usage-dashboard.mjs';
import { openRouterRates } from '../model-usage-reference.mjs';
import { formatSubagentSavings } from '../public/usage-equivalent.js';

const models = [
  { value: 'anthropic/claude-haiku-5.5', description: '$1 in / $5 out per 1M tokens • Tool calling' },
  { value: 'anthropic/claude-opus-5.5', description: '$5 in / $25 out per 1M tokens • Tool calling' },
  { value: 'openai/gpt-6-luna', description: '$0.5 in / $2 out per 1M tokens' }
];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const sub = (fields) => ({ at: '2026-10-01T00:00:00Z', purpose: 'subagent', agent: 'explorer', ...fields });

test('reads OpenRouter per-token rates from the catalog', () => {
  assert.deepEqual(openRouterRates(models, 'anthropic/claude-opus-5.5'), { input: 5, output: 25 });
  assert.equal(openRouterRates(models, 'missing/model'), null);
  assert.equal(openRouterRates([{ value: 'x/free', description: 'Free' }], 'x/free'), null);
});

test('saving is subagent tokens at the primary price minus their reported charge', () => {
  const events = [
    { purpose: 'main', provider: 'openrouter', model: 'anthropic/claude-opus-5.5', inputTokens: 9_000_000, outputTokens: 9_000_000, cost: 99 },
    sub({ provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', inputTokens: 1_000_000, outputTokens: 100_000, cost: 1.5 })
  ];
  const result = subagentSavings(events, { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' }, models);
  close(result.primaryCost, 7.5); // 1M × $5 + 0.1M × $25
  close(result.subagentCost, 1.5);
  close(result.saved, 6);
  assert.equal(result.responses, 1);
  assert.equal(result.assumedCacheRate, false);
});

test('subscription and local subagents are priced at their own model rates', () => {
  const events = [
    sub({ provider: 'openai-codex', model: 'gpt-6-luna', inputTokens: 1_000_000, outputTokens: 0 }),
    sub({ provider: 'local-abc', model: 'frognano-4b', inputTokens: 1_000_000, outputTokens: 0 })
  ];
  const result = subagentSavings(events, { provider: 'openai-codex', model: 'gpt-6.1-sol' }, models);
  close(result.primaryCost, 4); // gpt-6.1-sol $2 input, twice
  close(result.subagentCost, 0.5); // luna from the catalog, local free
  close(result.saved, 3.5);
});

test('cached input is priced once, and unpublished cache rates are flagged as assumed', () => {
  const event = sub({ provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', inputTokens: 1_000_000, cachedReadTokens: 800_000, outputTokens: 0, cost: 0.3 });
  const known = subagentSavings([event], { provider: 'claude-code', model: 'opus' }, models);
  close(known.primaryCost, 1.4); // 0.2M × $5 + 0.8M × $0.50
  assert.equal(known.assumedCacheRate, false);
  const assumed = subagentSavings([event], { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' }, models);
  close(assumed.primaryCost, 1.4); // read assumed at 10% of $5
  assert.equal(assumed.assumedCacheRate, true);
});

test('a subagent model dearer than the primary shows a negative saving', () => {
  const events = [sub({ provider: 'openrouter', model: 'anthropic/claude-opus-5.5', inputTokens: 1_000_000, outputTokens: 0, cost: 5 })];
  const result = subagentSavings(events, { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }, models);
  close(result.saved, -4);
  assert.equal(formatSubagentSavings(result), '−$4.00 (cost more)');
});

test('unpriceable responses are counted, and no primary price means no estimate', () => {
  const events = [
    sub({ provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', inputTokens: 1000, outputTokens: 0, cost: 0.001 }),
    sub({ provider: 'openrouter', model: 'unknown/model', inputTokens: 1000, outputTokens: 0, cost: null })
  ];
  const result = subagentSavings(events, { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' }, models);
  assert.equal(result.responses, 1);
  assert.equal(result.unpricedResponses, 1);
  assert.equal(formatSubagentSavings(result), '$0.0040 (partial)');
  assert.equal(subagentSavings(events, { provider: 'openrouter', model: 'unknown/model' }, models), null);
  assert.equal(subagentSavings([], { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' }, models), null);
  assert.equal(formatSubagentSavings(null), 'Unavailable');
});

test('the usage popup shows the estimate with a one-line definition', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(app, /\['Subagents · est\. saved', formatSubagentSavings\(state\.subagentSavings\)\]/);
  assert.match(app, /Est\. saved: what the subagents' tokens would have cost at .*'s per-token price, minus what they cost on their own models\./);
  assert.match(server, /subagentSavings: subagentSavings\(meta\.usage\?\.events, meta, await readCatalogModels\(catalogFile\)\)/);
});
