import assert from "node:assert/strict";
import test from "node:test";
import { startProgress, finishProgress, recordTool, recordResponse, progressSnapshot } from "../public/live-progress.js";

test("overlapping tool events form separate elapsed-time lanes", () => {
  const progress = startProgress(1000);
  recordTool(progress, { toolCallId: "one", title: "First", status: "pending" }, 2000);
  recordTool(progress, { toolCallId: "two", title: "Second", status: "in_progress" }, 3000);
  recordTool(progress, { toolCallId: "one", status: "completed" }, 4000);
  const snapshot = progressSnapshot(progress, 5000);
  assert.equal(snapshot.running, 1);
  assert.deepEqual(snapshot.tools.map(({ title, status, left, width }) => ({ title, status, left, width })), [
    { title: "First", status: "completed", left: 25, width: 50 },
    { title: "Second", status: "running", left: 50, width: 50 }
  ]);
});

test("updates arriving before a start and duplicate completions do not create extra lanes", () => {
  const progress = startProgress(1000);
  recordTool(progress, { toolCallId: "x", status: "failed" }, 1000);
  recordTool(progress, { toolCallId: "x", title: "Build", status: "failed" }, 2000);
  const snapshot = progressSnapshot(progress, 3000);
  assert.equal(snapshot.tools.length, 1);
  assert.equal(snapshot.tools[0].title, "Build");
  assert.equal(snapshot.tools[0].status, "failed");
  assert.equal(snapshot.tools[0].width, 0);
  assert.equal(snapshot.running, 0);
  assert.equal(progressSnapshot(startProgress(1000), 1000).elapsed, 1);
});

test("finished progress freezes the clock, marks unfinished tools interrupted, and ignores late events", () => {
  const progress = startProgress(1000);
  recordTool(progress, { toolCallId: "one", title: "Slow", status: "pending" }, 2000);
  recordTool(progress, { toolCallId: "two", title: "Fast", status: "completed" }, 2500);
  finishProgress(progress, "failed", 4000);
  finishProgress(progress, "completed", 5000);
  recordTool(progress, { toolCallId: "three", status: "pending" }, 6000);
  const snapshot = progressSnapshot(progress, 10000);
  assert.equal(snapshot.elapsed, 3000);
  assert.equal(snapshot.outcome, "failed");
  assert.equal(snapshot.running, 0);
  assert.deepEqual(snapshot.tools.map((tool) => tool.status), ["interrupted", "completed"]);
});

test("tool return, last response text and prompt result keep distinct observed end times", () => {
  const progress = startProgress(1000);
  recordTool(progress, { toolCallId: "a", title: "Build", status: "pending" }, 1500);
  recordTool(progress, { toolCallId: "a", status: "in_progress" }, 2000);
  recordTool(progress, { toolCallId: "a", status: "completed" }, 2400);
  recordTool(progress, { toolCallId: "a", status: "in_progress" }, 2600); // stale update
  recordResponse(progress, 3800);
  finishProgress(progress, "completed", 4200);
  recordResponse(progress, 4600); // late replay cannot move the marker
  const snapshot = progressSnapshot(progress, 9000);
  assert.equal(snapshot.tools[0].endedAt, 2400);
  assert.equal(snapshot.tools[0].status, "completed");
  assert.equal(snapshot.responseAt, 3800);
  assert.equal(snapshot.endedAt, 4200);
  assert.equal(snapshot.elapsed, 3200);
  assert.equal(snapshot.tools[0].width, 900 / 3200 * 100);
  assert.equal(progressSnapshot(startProgress(1000), 2000).responseAt, null);
});

test("text before a later tool is not mislabeled as the final response", () => {
  const progress = startProgress(1000);
  recordResponse(progress, 1200);
  recordTool(progress, { toolCallId: "a", status: "pending" }, 1400);
  assert.equal(progress.responseAt, null);
  recordTool(progress, { toolCallId: "a", status: "completed" }, 2000);
  recordResponse(progress, 2300);
  finishProgress(progress, "completed", 2600);
  assert.equal(progressSnapshot(progress).responseAt, 2300);
});

test("reasoning summaries group tools by start, not by completion (even with overlapping calls)", async () => {
  const { recordThought, progressGroups, hydrateProgress } = await import("../public/live-progress.js");
  const progress = startProgress(1000);
  recordTool(progress, { toolCallId: "early", title: "Before", status: "completed" }, 1100);
  recordThought(progress, { messageId: "a", content: { text: "Inspecting " } }, 1200);
  recordThought(progress, { messageId: "a", content: { text: "provider pricing" } }, 1250);
  recordTool(progress, { toolCallId: "one", title: "Search", status: "pending" }, 1300);
  recordTool(progress, { toolCallId: "two", title: "Inspect", status: "pending" }, 1350);
  recordThought(progress, { messageId: "b", content: { text: "Checking cached rates" } }, 1400);
  recordTool(progress, { toolCallId: "one", status: "completed" }, 1500);
  recordTool(progress, { toolCallId: "three", title: "Tests", status: "completed" }, 1550);
  const groups = progressGroups(progressSnapshot(progress, 2000));
  assert.deepEqual(groups.map(({ step, tools }) => [step?.text || null, tools.map((tool) => tool.id)]), [
    [null, ["early"]], ["Inspecting provider pricing", ["one", "two"]], ["Checking cached rates", ["three"]]
  ]);
  const { serializeTurn } = await import("../turn-history.mjs");
  assert.deepEqual(progressGroups(progressSnapshot(hydrateProgress(serializeTurn(progress)), 2000))
    .map(({ step, tools }) => [step?.text || null, tools.map((tool) => tool.id)]),
    groups.map(({ step, tools }) => [step?.text || null, tools.map((tool) => tool.id)]));
});

test("without a reasoning summary, tools remain ungrouped and no summary is invented", async () => {
  const { progressGroups } = await import("../public/live-progress.js");
  const progress = startProgress(1000);
  recordTool(progress, { toolCallId: "a", status: "pending" }, 1100);
  assert.deepEqual(progressGroups(progressSnapshot(progress, 1200)).map(({ step, tools }) => [step, tools.length]), [[null, 1]]);
});

test("distinct reasoning messages remain separate steps even with no tool between them", async () => {
  const { recordThought, progressGroups } = await import("../public/live-progress.js");
  const progress = startProgress(1000);
  recordThought(progress, { messageId: "first", content: { text: "Adding totals" } }, 1100);
  recordThought(progress, { messageId: "next", content: { text: "Planning layout" } }, 1200);
  recordTool(progress, { toolCallId: "one", title: "sed -n '1,50p' file", status: "completed" }, 1300);
  recordThought(progress, { content: { text: "Implementing" } }, 1400);
  recordThought(progress, { content: { text: "Checking" } }, 1450);
  assert.deepEqual(progressGroups(progressSnapshot(progress, 2000)).map(({ step, tools }) =>
    [step.text, tools.map(({ title }) => title)]), [
    ["Adding totals", []], ["Planning layout", ["sed -n '1,50p' file"]], ["Implementing", []], ["Checking", []]
  ]);
});
