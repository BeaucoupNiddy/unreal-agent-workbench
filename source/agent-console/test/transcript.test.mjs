import assert from "node:assert/strict";
import test from "node:test";
import { appendMessageChunk, appendToolCall } from "../public/transcript.js";
import { groupTranscriptEntries } from "../public/activity.js";

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


test("a workspace diff emitted after the final reply stays with earlier activity", () => {
  const entries = [
    { type: "message", role: "user", id: "prompt" },
    { type: "thought", id: "reasoning" },
    { type: "tool", id: "search" },
    { type: "message", role: "agent", id: "answer" }
  ];
  appendToolCall(entries, { type: "tool", id: "workspace-diff-1", kind: "edit" });
  assert.deepEqual(groupTranscriptEntries(entries).map((item) => item.type), ["message", "activity", "message"]);
  assert.deepEqual(groupTranscriptEntries(entries)[1].entries.map((item) => item.id), ["reasoning", "search", "workspace-diff-1"]);
});

test("a late diff moves trailing activity before the reply without reordering the tools", () => {
  const entries = [{ type: "message", role: "user" }, { type: "message", role: "agent" }];
  appendToolCall(entries, { type: "tool", id: "build", kind: "execute" });
  assert.equal(entries.at(-1).id, "build"); // No speculative reordering while the turn is still running.
  appendToolCall(entries, { type: "tool", id: "workspace-diff-2", kind: "edit" });
  assert.deepEqual(entries.map((item) => item.id), [undefined, "build", "workspace-diff-2", undefined]);
  assert.deepEqual(groupTranscriptEntries(entries).map((item) => item.type), ["message", "activity", "message"]);

  const noReply = [{ type: "message", role: "agent" }, { type: "message", role: "user" }];
  appendToolCall(noReply, { type: "tool", id: "workspace-diff-3", kind: "edit" });
  assert.equal(noReply.at(-1).id, "workspace-diff-3");
});


test("a diff for a later turn does not move ahead of an earlier answer", () => {
  const entries = [
    { type: "message", role: "user", id: "first-prompt" },
    { type: "message", role: "agent", id: "first-answer" },
    { type: "message", role: "user", id: "second-prompt" },
    { type: "message", role: "agent", id: "second-answer" }
  ];
  appendToolCall(entries, { type: "tool", id: "workspace-diff-second", kind: "edit" });
  assert.deepEqual(entries.map((item) => item.id), [
    "first-prompt", "first-answer", "second-prompt", "workspace-diff-second", "second-answer"
  ]);
});

test("multiple late tools and diffs remain together before the final reply on replay", () => {
  const entries = [
    { type: "message", role: "user", id: "prompt" },
    { type: "tool", id: "start", kind: "execute" },
    { type: "message", role: "agent", id: "answer" },
    { type: "tool", id: "late", kind: "execute" },
    { type: "thought", id: "late-thought" }
  ];
  appendToolCall(entries, { type: "tool", id: "workspace-diff-4", kind: "edit" });
  appendToolCall(entries, { type: "tool", id: "workspace-diff-5", kind: "edit" });
  assert.deepEqual(entries.map((item) => item.id), [
    "prompt", "start", "late", "late-thought", "workspace-diff-4", "workspace-diff-5", "answer"
  ]);
  assert.deepEqual(groupTranscriptEntries(entries).map((item) => item.type), ["message", "activity", "message"]);
});
