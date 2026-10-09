import test from 'node:test';
import assert from 'node:assert/strict';
import { getSubscriptionUsage, normalizeSubscriptionUsage } from '../subscription-usage.mjs';

test('Codex windows report consumed percentage and reset times', () => {
  const result = normalizeSubscriptionUsage('openai-codex', { rate_limit: {
    primary: { used_percent: 27.4, resets_at: 1800000000 }, secondary: { used_percent: 5, resets_at: 1800400000 }
  } });
  assert.equal(result.short.percent, 27.4);
  assert.equal(result.long.percent, 5);
  assert.equal(result.short.resetsAt, new Date(1800000000 * 1000).toISOString());
  assert.equal(result.available, true);
});

test('Codex wham usage response uses primary_window and reset_at', () => {
  const result = normalizeSubscriptionUsage('openai-codex', { rate_limit: {
    allowed: true,
    primary_window: { used_percent: 57, limit_window_seconds: 18000, reset_at: 1790640235 },
    secondary_window: { used_percent: 24, limit_window_seconds: 604800, reset_at: 1791054259 }
  } });
  assert.equal(result.short.percent, 57);
  assert.equal(result.long.percent, 24);
  assert.equal(result.short.resetsAt, new Date(1790640235 * 1000).toISOString());
  assert.equal(result.long.resetsAt, new Date(1791054259 * 1000).toISOString());
  assert.equal(result.available, true);
});

test('Claude utilization and unavailable responses are not mistaken for zero', () => {
  assert.deepEqual(normalizeSubscriptionUsage('claude-code', {
    five_hour: { utilization: 48, resets_at: '2026-06-26T00:00:00Z' }, seven_day: { utilization: 12 }
  }).short, { percent: 48, resetsAt: '2026-06-26T00:00:00Z' });
  const missing = normalizeSubscriptionUsage('claude-code', { five_hour: { utilization: -1 } });
  assert.equal(missing.available, false);
  assert.equal(missing.short.percent, null);
});

test('fetches only from fixed provider origin and returns no credentials', async () => {
  const result = await getSubscriptionUsage('claude-code', {
    getCredentials: async () => ({ url: 'https://api.anthropic.com/api/oauth/usage', headers: { Authorization: 'Bearer secret' } }),
    fetch: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
      assert.equal(options.headers.Authorization, 'Bearer secret');
      return { ok: true, json: async () => ({ five_hour: { utilization: 63 } }) };
    }
  });
  assert.equal(result.short.percent, 63);
  assert.ok(!JSON.stringify(result).includes('secret'));
  await assert.rejects(() => getSubscriptionUsage('unknown'), /Unsupported/);
});


test('fresh reads bypass the quota cache when a thread begins or finishes', async () => {
  let reads = 0;
  const options = {
    getCredentials: async () => ({ url: 'https://chatgpt.com/backend-api/wham/usage', headers: {} }),
    fetch: async () => ({ ok: true, json: async () => ({ rate_limit: { primary: { used_percent: ++reads } } }) }),
    now: () => 1800000000000
  };
  const cached = await getSubscriptionUsage('openai-codex', options);
  const fresh = await getSubscriptionUsage('openai-codex', { ...options, force: true });
  assert.equal(fresh.short.percent, cached.short.percent + 1);
  assert.equal((await getSubscriptionUsage('openai-codex', options)).short.percent, fresh.short.percent);
  assert.equal(reads, 2);
});
