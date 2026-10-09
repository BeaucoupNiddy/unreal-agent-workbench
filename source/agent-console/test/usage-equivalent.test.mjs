import test from 'node:test';
import assert from 'node:assert/strict';
import { apiEquivalent, threadContextPercent } from '../public/usage-equivalent.js';

test('prices conversation tokens at model API rates, with cached input counted only once', () => {
  const usage = { inputTokens: 1_000_000, cachedReadTokens: 400_000,
    cachedWriteTokens: 100_000, outputTokens: 200_000 };
  // 500k ordinary input + 400k reads + 100k writes + 200k output.
  assert.equal(apiEquivalent(usage, 'claude-code', 'sonnet'), 4.995);
  assert.equal(apiEquivalent(usage, 'claude-code', 'opus'), 8.325);
  assert.equal(apiEquivalent({ inputTokens: 1_000_000, cachedReadTokens: 250_000,
    outputTokens: 100_000 }, 'openai-codex', 'gpt-5.2'), 2.75625);
  assert.equal(apiEquivalent({ inputTokens: 100_000, cachedReadTokens: 90_000,
    cachedWriteTokens: 5_000, outputTokens: 10_000 }, 'openai-codex', 'gpt-6-sol'), 0.1405);
  // OpenAI's published GPT-6.1 Sol cache-read rate is 5%, not the 10% heuristic.
  assert.equal(apiEquivalent({ inputTokens: 100_000, cachedReadTokens: 90_000,
    outputTokens: 10_000 }, 'openai-codex', 'gpt-6.1-sol'), 0.129);
});

test('does not invent rates or double-count inconsistent usage', () => {
  assert.equal(apiEquivalent({}, 'openai-codex', 'gpt-6-astra'), null);
  assert.equal(apiEquivalent({}, 'claude-code', 'claude-opus-99'), null);
  assert.equal(apiEquivalent({}, 'openrouter', 'sonnet'), null);
  assert.equal(apiEquivalent({ inputTokens: 10, cachedReadTokens: 11 }, 'claude-code', 'sonnet'), null);
  assert.equal(apiEquivalent({ inputTokens: 10, cachedWriteTokens: 1 }, 'openai-codex', 'gpt-5'), null);
  assert.equal(apiEquivalent({ inputTokens: 10, cachedReadTokens: 10 }, 'openai-codex', 'gpt-5'), 0.00000125);
  assert.equal(apiEquivalent({}, 'claude-code', 'haiku'), 0);
});

test('context percentage is latest context, not account-wide subscription utilization', () => {
  assert.equal(threadContextPercent({ used: 5_000, size: 20_000 }), 25);
  assert.equal(threadContextPercent({ used: 0, size: 20_000 }), 0);
  assert.equal(threadContextPercent({ used: 5_000, size: 0 }), null);
  assert.equal(threadContextPercent({ used: 5_000 }), null);
});
