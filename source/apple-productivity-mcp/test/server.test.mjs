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
