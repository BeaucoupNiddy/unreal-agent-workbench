import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureSubscriptionBaseline, readSubscriptionBaseline, deleteSubscriptionBaseline } from '../subscription-baseline.mjs';
import { subscriptionIncrease } from '../public/subscription-delta.js';

test('captured at creation with a fresh provider read, persisted per chat and removed on delete', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'ua-sub-'));
  try {
    const id = 'hydra_session_123';
    const start = { short: { percent: 21.3, resetsAt: '2026-09-28T20:00:00Z' },
      long: { percent: 4, resetsAt: '2026-10-04T20:00:00Z' } };
    const captured = await captureSubscriptionBaseline(folder, id, 'claude-code', async (provider, options) => {
      assert.equal(provider, 'claude-code');
      assert.deepEqual(options, { force: true });
      return start;
    });
    assert.deepEqual(captured.short, start.short);
    assert.deepEqual(await readSubscriptionBaseline(folder, id), captured);
    assert.equal(subscriptionIncrease(captured.short, { percent: 24.8, resetsAt: start.short.resetsAt }), 3.5);
    await deleteSubscriptionBaseline(folder, id);
    assert.equal(await readSubscriptionBaseline(folder, id), null);
    assert.equal(await captureSubscriptionBaseline(folder, '../bad', 'claude-code', () => { throw Error('must not run'); }), null);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('unknown baselines, resets and falling quota values are not attributed to the thread', () => {
  const start = { percent: 40, resetsAt: '2026-09-28T20:00:00Z' };
  assert.equal(subscriptionIncrease(null, { percent: 50 }), null);
  assert.equal(subscriptionIncrease({ percent: null }, { percent: 50 }), null);
  assert.equal(subscriptionIncrease(start, { percent: 5, resetsAt: '2026-09-28T21:00:00Z' }), null);
  assert.equal(subscriptionIncrease(start, { percent: 30, resetsAt: start.resetsAt }), null);
  assert.equal(subscriptionIncrease(start, { percent: 40, resetsAt: start.resetsAt }), 0);
});
