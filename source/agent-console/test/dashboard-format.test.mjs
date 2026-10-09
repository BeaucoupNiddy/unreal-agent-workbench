import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDashboardTokens } from '../public/dashboard-format.js';

test('dashboard token counts use uppercase compact units without rounding up', () => {
  assert.equal(formatDashboardTokens(0), '0');
  assert.equal(formatDashboardTokens(999), '999');
  assert.equal(formatDashboardTokens(1000), '1K');
  assert.equal(formatDashboardTokens(1264), '1.2K');
  assert.equal(formatDashboardTokens(999999), '999.9K');
  assert.equal(formatDashboardTokens(1000000), '1M');
  assert.equal(formatDashboardTokens(1264877), '1.2M');
  assert.equal(formatDashboardTokens(8352075), '8.3M');
  assert.equal(formatDashboardTokens(1264877000), '1.2B');
  assert.equal(formatDashboardTokens(-9), '0');
});
