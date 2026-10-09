import test from 'node:test';
import assert from 'node:assert/strict';
import { modelUsageReference } from '../model-usage-reference.mjs';
import { apiEquivalent, assumesCacheReadRate, threadContextPercent } from '../public/usage-equivalent.js';

test('matches only the exact Codex model to cached OpenRouter API reference prices and context', () => {
  const catalog = [
    { value: 'openai/gpt-6-sol', description: '$2 in / $10 out per 1M tokens • Tool calling', contextWindow: 1050000 },
    { value: 'openai/gpt-6-sol:batch', description: '$1 in / $5 out per 1M tokens', contextWindow: 1050000 }
  ];
  const reference = modelUsageReference(catalog, 'openai-codex', 'gpt-6-sol');
  assert.deepEqual(reference.pricing, { input: 2, output: 10, source: 'OpenRouter' });
  assert.equal(threadContextPercent({ used: 210000, size: reference.contextWindow }), 20);
  assert.equal(apiEquivalent({ inputTokens: 100000, cachedReadTokens: 90000, outputTokens: 10000 }, 'openai-codex', 'gpt-6-sol', reference), 0.138);
  assert.equal(assumesCacheReadRate({ cachedReadTokens: 90000 }, 'openai-codex', 'gpt-6-sol', reference), false);
  assert.equal(apiEquivalent({ inputTokens: 100000, cachedReadTokens: 90000, outputTokens: 10000 },
    'openai-codex', 'gpt-6-sol', { pricing: { input: 100, output: 500 } }), .138);
  assert.equal(apiEquivalent({ inputTokens: 100000, outputTokens: 10000 }, 'openai-codex', 'gpt-6-sol', reference), .3);
  // Unlisted Codex models use 10% of the catalog input rate as a *heuristic*.
  assert.equal(assumesCacheReadRate({ cachedReadTokens: 90000 }, 'openai-codex', 'gpt-6-astra', reference), true);
  assert.equal(apiEquivalent({ inputTokens: 100000, cachedReadTokens: 90000, outputTokens: 10000 },
    'openai-codex', 'gpt-6-astra', { pricing: reference.pricing }), .138);
  assert.equal(apiEquivalent({ inputTokens: 100000, cachedWriteTokens: 1000 },
    'openai-codex', 'gpt-6-astra', { pricing: reference.pricing }), null);
  assert.equal(modelUsageReference(catalog, 'openai-codex', 'gpt-6-sol:batch'), null);
  assert.equal(modelUsageReference(catalog, 'claude-code', 'gpt-6-sol'), null);
  assert.equal(modelUsageReference(catalog, 'openai-codex', 'gpt-6-unknown'), null);
});
