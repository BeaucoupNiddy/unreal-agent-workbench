import test from "node:test";
import assert from "node:assert/strict";
import { AutoTitleScheduler } from "../auto-title.mjs";

test("regenerates a tracked title once after a successful prompt", async () => {
  const calls = [];
  const scheduler = new AutoTitleScheduler(async (sessionId) => calls.push(sessionId));
  scheduler.track("session-1");

  assert.equal(await scheduler.afterPrompt("session-1"), true);
  assert.equal(await scheduler.afterPrompt("session-1"), false);
  assert.deepEqual(calls, ["session-1"]);
});

test("retries title generation after a transient failure", async () => {
  let attempts = 0;
  const scheduler = new AutoTitleScheduler(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("backend unavailable");
  });
  scheduler.track("session-1");

  await assert.rejects(scheduler.afterPrompt("session-1"), /backend unavailable/);
  assert.equal(await scheduler.afterPrompt("session-1"), true);
  assert.equal(attempts, 2);
});

test("ignores sessions that were not created as untitled console drafts", async () => {
  const scheduler = new AutoTitleScheduler(async () => assert.fail("should not regenerate"));
  assert.equal(await scheduler.afterPrompt("existing-session"), false);
});
