import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TurnHistory } from "../turn-history.mjs";
import { hydrateProgress, progressSnapshot } from "../public/live-progress.js";

test("turn timelines persist overlapping tools and completed turns across server restart", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), "turn-history-test-"));
  try {
    const file = path.join(dir, "turns.json");
    const history = new TurnHistory(file);
    await history.load();
    history.start(1000);
    history.tool({ toolCallId: "a", title: "Install", status: "in_progress" }, 2000);
    history.tool({ toolCallId: "b", title: "Archive", status: "in_progress" }, 2500);
    history.tool({ toolCallId: "a", status: "completed" }, 4000);
    history.finish("completed", 5000);
    await history.pending;
    const restored = new TurnHistory(file);
    const [turn] = await restored.load();
    assert.equal(turn.outcome, "completed");
    const snapshot = progressSnapshot(hydrateProgress(turn), 10000);
    assert.equal(snapshot.elapsed, 4000);
    assert.deepEqual(snapshot.tools.map(({ title, status, left, width }) => [title, status, left, width]), [
      ["Install", "completed", 25, 50], ["Archive", "interrupted", 37.5, 62.5]
    ]);
    restored.start(11000);
    restored.finish("failed", 12000);
    await restored.pending;
    assert.equal((await new TurnHistory(file).load()).length, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("restart interrupts an in-flight turn at its last observed event", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), "turn-history-test-"));
  try {
    const file = path.join(dir, "turns.json");
    const history = new TurnHistory(file);
    history.start(1000);
    history.tool({ toolCallId: "a", title: "Running", status: "pending" }, 2000);
    await history.pending;
    const [saved] = await new TurnHistory(file).load();
    assert.equal(saved.endedAt, 2000);
    assert.equal(saved.outcome, "interrupted");
    assert.equal(saved.tools[0].status, "interrupted");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("persists separate tool-return, response-text and request-complete timestamps", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), "turn-history-test-"));
  try {
    const file = path.join(dir, "turns.json");
    const history = new TurnHistory(file);
    history.start(1000);
    history.tool({ toolCallId: "a", title: "Build", status: "pending" }, 1500);
    history.tool({ toolCallId: "a", status: "completed" }, 2400);
    history.response(3800);
    history.finish("completed", 4200);
    history.response(4600);
    await history.pending;
    const [saved] = await new TurnHistory(file).load();
    assert.equal(saved.responseAt, 3800);
    assert.equal(saved.tools[0].endedAt, 2400);
    assert.equal(saved.endedAt, 4200);
    const snapshot = progressSnapshot(hydrateProgress(saved), 9000);
    assert.equal(snapshot.responseAt, 3800);
    assert.equal(snapshot.endedAt, 4200);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("restart stops an unfinished turn at the last observed response, not the last tool", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), "turn-history-test-"));
  try {
    const file = path.join(dir, "turns.json");
    const history = new TurnHistory(file);
    history.start(1000);
    history.tool({ toolCallId: "a", title: "Running", status: "completed" }, 2000);
    history.response(3100);
    await history.pending;
    const [saved] = await new TurnHistory(file).load();
    assert.equal(saved.endedAt, 3100);
    assert.equal(saved.responseAt, 3100);
    assert.equal(saved.outcome, "interrupted");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("reasoning steps and tool memberships survive a server restart", async () => {
  const { progressGroups } = await import("../public/live-progress.js");
  const dir = await fs.mkdtemp(path.join(process.cwd(), "turn-history-test-"));
  try {
    const file = path.join(dir, "turns.json");
    const history = new TurnHistory(file);
    history.start(1000);
    history.thought({ messageId: "a", content: { text: "Investigating" } }, 1200);
    history.tool({ toolCallId: "one", title: "Search", status: "pending" }, 1300);
    history.thought({ messageId: "b", content: { text: "Validating" } }, 1400);
    history.tool({ toolCallId: "two", title: "Tests", status: "completed" }, 1500);
    history.tool({ toolCallId: "one", status: "completed" }, 1700);
    history.finish("completed", 1900);
    await history.pending;
    const [saved] = await new TurnHistory(file).load();
    assert.deepEqual(progressGroups(progressSnapshot(hydrateProgress(saved))).map(({ step, tools }) =>
      [step?.text, tools.map((tool) => tool.title)]), [["Investigating", ["Search"]], ["Validating", ["Tests"]]]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("restart stops a thought-only in-flight turn at its last summary", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), "turn-history-test-"));
  try {
    const file = path.join(dir, "turns.json");
    const history = new TurnHistory(file);
    history.start(1000);
    history.thought({ content: { text: "Considering options" } }, 2100);
    await history.pending;
    const [turn] = await new TurnHistory(file).load();
    assert.equal(turn.endedAt, 2100);
    assert.equal(turn.steps[0].text, "Considering options");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
