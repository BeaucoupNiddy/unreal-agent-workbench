import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireSessionWriter } from '../src/session-writer.mjs';
test('a session has one writer, while other sessions run independently', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'session-writer-'));
  try {
    const release = await acquireSessionWriter(root, 'one');
    await assert.rejects(acquireSessionWriter(root, 'one'), /active writer/);
    const independent = await acquireSessionWriter(root, 'two');
    await independent(); await release();
    await (await acquireSessionWriter(root, 'one'))();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
