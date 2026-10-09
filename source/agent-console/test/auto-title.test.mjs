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

test("recognizes Hydra's raw and truncated first-prompt titles after restart, not generated titles", async () => {
  const { isProvisionalTitle } = await import("../auto-title.mjs");
  const prompt = "Investigate why chat titles keep showing the entire first message instead of summaries";
  const history = ["garbage", JSON.stringify({ params: { update: { sessionUpdate: "prompt_received", prompt: [{ type: "text", text: prompt }] } } })].join("\n");
  assert.equal(isProvisionalTitle(prompt, history), true);
  assert.equal(isProvisionalTitle(`${prompt.slice(0, 28)}…`, history), true);
  assert.equal(isProvisionalTitle("Fix automatic chat titles", history), false);
  assert.equal(isProvisionalTitle("New chat", ""), false);
});

test("reattaching a stranded console session restores a single pending title", async () => {
  const { recoverProvisionalTitle } = await import("../auto-title.mjs");
  const { promises: fs } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(tmpdir(), "auto-title-"));
  const id = "hydra_session_test";
  try {
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(path.join(root, id, "meta.json"), JSON.stringify({ agentId: "unreal", originatingClient: { name: "unreal-agent-console" }, title: "Fix automatic chat titles" }));
    await fs.writeFile(path.join(root, id, "history.jsonl"), JSON.stringify({ params: { update: { sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "Fix automatic chat titles" }] } } }));
    const calls = [];
    const scheduler = new AutoTitleScheduler(async (session) => calls.push(session));
    const complete = JSON.stringify({ params: { update: { sessionUpdate: "turn_complete" } } });
    await fs.appendFile(path.join(root, id, "history.jsonl"), `\n${complete}`);
    let triggered = 0;
    assert.equal(await recoverProvisionalTitle(root, id, scheduler, () => { triggered++; }), true);
    assert.equal(triggered, 1);
    // Reattaching an already tracked draft must not start duplicate generation.
    assert.equal(await recoverProvisionalTitle(root, id, scheduler, () => { triggered++; }), true);
    assert.equal(triggered, 1);
    assert.equal(await scheduler.afterPrompt(id), true);
    assert.equal(await scheduler.afterPrompt(id), false);
    assert.deepEqual(calls, [id]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
