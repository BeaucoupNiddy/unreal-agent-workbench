import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readAuxiliaryUsage, saveAuxiliaryUsage } from '../src/auxiliary-usage.mjs';

test('auxiliary usage is durable, private, idempotent per job/response and independent of its parent chat', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'auxiliary-usage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readAuxiliaryUsage(root), []);
  const event = { jobId: 'one', responseId: 'response', purpose: 'memory', inputTokens: 12 };
  await Promise.all([saveAuxiliaryUsage(root, event), saveAuxiliaryUsage(root, event)]);
  await saveAuxiliaryUsage(root, { ...event, jobId: 'two' });
  assert.equal((await readAuxiliaryUsage(root)).length, 2);
  const directory = path.join(root, 'auxiliary-usage');
  const names = await fs.readdir(directory);
  assert.equal(names.length, 2); assert.ok(names.every((name) => name.endsWith('.json')));
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    for (const name of names) assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
  }
  await fs.writeFile(path.join(directory, 'incomplete.tmp'), '{');
  await fs.writeFile(path.join(directory, 'corrupt.json'), '{');
  await fs.writeFile(path.join(directory, 'null.json'), 'null');
  assert.equal((await readAuxiliaryUsage(root)).length, 2);
});
