import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyRuntime } from '../src/runtime-integrity.mjs';
const hash = (text) => createHash('sha256').update(text).digest('hex');
test('runtime starts only with a matching source, official binary, companion and manifest', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'runtime-pair-'));
  try {
    const official = path.join(root, 'official'), live = path.join(root, 'live');
    await fs.writeFile(official, 'official'); await fs.writeFile(live, 'companion');
    const extension = createHash('sha256');
    for (const name of ['runner.patch', 'live_input.go', 'live_input_test.go']) {
      await fs.writeFile(path.join(root, name), name); extension.update(name); extension.update(name);
    }
    await fs.writeFile(`${live}.json`, JSON.stringify({ upstreamRevision: 'revision', binarySHA256: hash('companion'),
      officialBinarySHA256: hash('official'), extensionSHA256: extension.digest('hex') }));
    assert.equal((await verifyRuntime(live, official, root)).upstreamRevision, 'revision');
    await fs.writeFile(path.join(root, '.update-in-progress'), 'updating');
    await assert.rejects(verifyRuntime(live, official, root), /being updated/);
    await fs.unlink(path.join(root, '.update-in-progress'));
    await fs.writeFile(official, 'different');
    await assert.rejects(verifyRuntime(live, official, root), /do not match/);
    await fs.writeFile(official, 'official'); await fs.appendFile(path.join(root, 'live_input.go'), 'changed');
    await assert.rejects(verifyRuntime(live, official, root), /older than its source/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
