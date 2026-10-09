import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConsoleInputs } from '../console-inputs.mjs';
test('accepted messages survive console restart with stable IDs; completed and cancelled inputs are removed', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'console-inputs-'));
  try {
    const store = new ConsoleInputs(root);
    await store.save('chat', 'one', 'first', []);
    await store.save('chat', 'one', 'first', []);
    await store.save('chat', 'two', 'second', [{ data: 'abc', mimeType: 'image/png' }]);
    const recovered = new ConsoleInputs(root);
    assert.deepEqual((await recovered.pending('chat')).map((value) => value.inputId), ['one', 'two']);
    await assert.rejects(recovered.save('chat', 'one', 'different', []), /different content/);
    await recovered.complete('chat', 'one');
    assert.equal((await recovered.pending('chat')).length, 1);
    await recovered.discard('chat'); assert.deepEqual(await recovered.pending('chat'), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
