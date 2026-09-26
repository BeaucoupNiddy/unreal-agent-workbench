import assert from "node:assert/strict";
import test from "node:test";
import { appendMessageChunk } from "../public/transcript.js";

test("Hydra's user-message echo adopts the optimistic bubble instead of duplicating it", () => {
  const entries = [{ type: "message", id: "local-1", role: "user", text: "Please fix the mobile issue", images: [], localPending: true }];
  const byMessage = new Map([["local-1", entries[0]]]);

  appendMessageChunk(entries, byMessage, { role: "user", id: "hydra-1", text: "Please fix the mobile issue" });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "hydra-1");
  assert.equal(entries[0].text, "Please fix the mobile issue");
  assert.equal(byMessage.has("local-1"), false);
  assert.equal(byMessage.get("hydra-1"), entries[0]);
});

test("a chunked or replayed echo does not append the prompt again", () => {
  const entries = [{ type: "message", id: "local-2", role: "user", text: "Please fix the mobile issue", images: [], localPending: true }];
  const byMessage = new Map([["local-2", entries[0]]]);

  appendMessageChunk(entries, byMessage, { role: "user", id: "hydra-2", text: "Please fix " });
  appendMessageChunk(entries, byMessage, { role: "user", id: "hydra-2", text: "the mobile issue" });
  appendMessageChunk(entries, byMessage, { role: "user", id: "hydra-2", text: "Please fix the mobile issue" });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "Please fix the mobile issue");
});

test("non-optimistic message chunks continue to accumulate", () => {
  const entries = [];
  const byMessage = new Map();

  appendMessageChunk(entries, byMessage, { role: "agent", id: "agent-1", text: "First " });
  appendMessageChunk(entries, byMessage, { role: "agent", id: "agent-1", text: "answer" });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "First answer");
});
