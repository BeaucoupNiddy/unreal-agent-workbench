import test from 'node:test';
import assert from 'node:assert/strict';
import { newInputId, recoverInputId, finishInputId } from '../public/input-recovery.js';
test('mobile HTTP clients can create valid UUIDs without secure-context randomUUID', () => {
  const id = newInputId({ getRandomValues(bytes) { bytes.fill(0); return bytes; } });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test('a prompt retry after an uncertain HTTP response keeps its ID across browser state reload', () => {
  const map = new Map(), storage = { getItem: (key) => map.get(key), setItem: (key, value) => map.set(key, value) };
  const first = recoverInputId('chat', 'hello', [], storage);
  assert.equal(recoverInputId('chat', 'hello', [], storage), first);
  assert.notEqual(recoverInputId('chat', 'different', [], storage), first);
  finishInputId(first, storage);
  assert.notEqual(recoverInputId('chat', 'hello', [], storage), first);
});
