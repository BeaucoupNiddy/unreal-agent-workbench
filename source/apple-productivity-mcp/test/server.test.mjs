import assert from "node:assert/strict";
import test from "node:test";
import { availableTools, handleMessage } from "../server.mjs";

test("capability filtering keeps disabled tool families out of discovery", () => {
  assert.deepEqual(availableTools(new Set(["notes"])).map((tool) => tool.name), ["notes_search", "notes_get", "notes_create"]);
  assert.deepEqual(availableTools(new Set(["calendar"])).map((tool) => tool.name), ["calendar_list", "calendar_today", "calendar_search", "calendar_create"]);
});

test("MCP tool calls return both text and structured data", async () => {
  const result = await handleMessage({ method: "tools/call", params: { name: "notes_search", arguments: { query: "test" } } }, async () => ({ notes: [] }));
  assert.deepEqual(result.structuredContent, { notes: [] });
  assert.match(result.content[0].text, /"notes"/);
});

test('read operations declare read-only behavior and create tools declare mutations', () => {
  for (const tool of availableTools(new Set(['notes', 'calendar']))) {
    assert.equal(tool.annotations.readOnlyHint, !tool.name.endsWith('_create'));
  }
});

test('protocol cancellation targets only its native call while another request continues', async () => {
  const requests = new Map();
  let other;
  const cancelled = handleMessage({ id: 1, method: 'tools/call', params: { name: 'notes_create' } }, async (_, __, { signal }) => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('native call cancelled')), { once: true }));
  }, requests);
  const ongoing = handleMessage({ id: 2, method: 'tools/call', params: { name: 'notes_search' } }, async (_, __, { signal }) => {
    other = signal; return new Promise((resolve) => { other.finish = () => resolve({ notes: [] }); });
  }, requests);
  await handleMessage({ method: 'notifications/cancelled', params: { requestId: 1 } }, undefined, requests);
  await assert.rejects(cancelled, /native call cancelled/);
  assert.equal(other.aborted, false); other.finish();
  assert.deepEqual((await ongoing).structuredContent, { notes: [] }); assert.equal(requests.size, 0);
});
