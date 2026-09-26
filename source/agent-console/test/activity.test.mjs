import assert from "node:assert/strict";
import test from "node:test";
import { activitySummary, groupTranscriptEntries } from "../public/activity.js";

test("groups each contiguous reasoning and tool run in transcript order", () => {
  const entries = [
    { type: "message", id: "u1", role: "user" },
    { type: "thought", id: "r1", text: "Inspect first" },
    { type: "tool", id: "t1", kind: "execute", input: { command: "rg foo" } },
    { type: "message", id: "a1", role: "agent" },
    { type: "tool", id: "t2", kind: "execute", input: { command: "npm test" } }
  ];

  const grouped = groupTranscriptEntries(entries);
  assert.deepEqual(grouped.map((entry) => entry.type), ["message", "activity", "message", "activity"]);
  assert.deepEqual(grouped[1].entries.map((entry) => entry.id), ["r1", "t1"]);
  assert.deepEqual(grouped[3].entries.map((entry) => entry.id), ["t2"]);
});

test("hides reasoning without hiding or merging tool activity", () => {
  const grouped = groupTranscriptEntries([
    { type: "thought", id: "r1" },
    { type: "tool", id: "t1" },
    { type: "message", id: "a1" },
    { type: "thought", id: "r2" }
  ], false);

  assert.deepEqual(grouped.map((entry) => entry.type), ["activity", "message"]);
  assert.deepEqual(grouped[0].entries.map((entry) => entry.id), ["t1"]);
});

test("builds a local summary from existing tool metadata", () => {
  assert.equal(activitySummary([
    { type: "thought" },
    { type: "tool", kind: "edit", title: "4 files changed" },
    { type: "tool", kind: "execute", input: { command: "rg -n tool public/app.js" } },
    { type: "tool", kind: "execute", input: { command: "npm test" } }
  ]), "Edited 4 files, Inspected 1 item, Ran 1 command");
  assert.equal(activitySummary([{ type: "thought" }]), "Thought through the next step");
});
