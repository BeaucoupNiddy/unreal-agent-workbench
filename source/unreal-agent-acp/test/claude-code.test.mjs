import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeArgs } from '../src/claude-code.mjs';
import { normalizeModelSettings, resolveProviderSettings } from '../src/model-settings.mjs';

test('Claude Code is available without user-created connection and does not use Codex model', () => {
  assert.deepEqual(normalizeModelSettings({ provider: 'claude-code', model: 'opus' }), { provider: 'claude-code', model: 'opus' });
  assert.deepEqual(resolveProviderSettings({ provider: 'openai-codex', model: 'gpt-6-astra' }, { provider: 'claude-code' }, {}), { provider: 'claude-code', model: 'sonnet' });
});
test('Claude invocation resumes and respects permissions', () => {
  const session = { id: 'unreal-12345678-1234-1234-1234-123456789012', model: 'sonnet', permissionMode: 'read-only' };
  assert.ok(claudeArgs(session, 'hello').includes('--tools'));
  assert.equal(claudeArgs(session, 'hello').includes('bypassPermissions'), false);
  // Terminal commands need bypass in print mode; Seatbelt or the Full Access approval bounds them.
  for (const mode of ['workspace-write', 'danger-full-access']) {
    session.permissionMode = mode;
    assert.ok(claudeArgs(session, 'hello').includes('bypassPermissions'));
    assert.equal(claudeArgs(session, 'hello').includes('--tools'), false);
  }
  session.claudeStarted = true;
  assert.ok(claudeArgs(session, 'next').includes('--resume'));
});

test('Codex status detects login without exposing tokens', async () => {
  const { codexStatus } = await import('../src/claude-code.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-status-'));
  const file = path.join(directory, 'auth.json');
  assert.equal((await codexStatus(file)).status, 'disconnected');
  await writeFile(file, JSON.stringify({ tokens: { access_token: 'unit-test-secret' } }));
  const result = await codexStatus(file);
  assert.equal(result.status, 'connected');
  assert.equal(JSON.stringify(result).includes('unit-test-secret'), false);
});

test('Claude failures preserve structured stdout details even on nonzero exit', async () => {
  const { claudeResult } = await import('../src/claude-code.mjs');
  assert.throws(() => claudeResult(JSON.stringify({ is_error: true, errors: ['Model access denied'] }), '', 1), /Model access denied/);
  assert.throws(() => claudeResult(JSON.stringify({ is_error: true, result: 'Request failed' }), '', 0), /Request failed/);
  assert.throws(() => claudeResult('', 'sandbox denied', 1), /sandbox denied/);
  assert.throws(() => claudeResult('invalid', '', 0), /invalid response/);
  assert.deepEqual(claudeResult('{"result":"hello"}', '', 0), { result: 'hello' });
});
