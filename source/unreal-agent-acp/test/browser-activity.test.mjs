import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendBrowserActivity, browserActivityDirectory, browserActivityOwner, browserImageName, describeBrowserStep, readBrowserActivity, readBrowserImage } from "../src/browser-activity.mjs";

test("subagents and swarm members record into their parent chat with their own label", () => {
  assert.deepEqual(browserActivityOwner({ id: "unreal-1" }), { chatId: "unreal-1", agentKey: "main", agent: "Main agent" });
  const sub = browserActivityOwner({ id: "unreal-1-sub-0123456789abcdef", parentId: "unreal-1", agentLabel: "Tester 2" });
  assert.equal(sub.chatId, "unreal-1");
  assert.equal(sub.agent, "Tester 2");
  assert.match(sub.agentKey, /^sub-[\w-]+$/);
  assert.equal(browserActivityDirectory("/data", "a/b"), path.join("/data", "sessions", "browser", "a_b"));
});

test("step descriptions are short and never show typed text", () => {
  assert.equal(describeBrowserStep("open", { url: "http://localhost:3000" }), "http://localhost:3000");
  assert.equal(describeBrowserStep("type", { label: "Password", text: "hunter2", submit: true }), "“Password” ← 7 characters, then Enter");
  assert.equal(describeBrowserStep("click", { ref: "e4" }), "ref e4");
  assert.equal(describeBrowserStep("wait", { text: "Saved", gone: true }), "for “Saved” to go");
  assert.equal(describeBrowserStep("screenshot", { fullPage: true }), "full page");
});

test("reads only new steps, reports a trimmed log, and summarizes each agent's latest page", async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ua-activity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await readBrowserActivity(directory), { total: 0, reset: false, entries: [], agents: [] });
  await appendBrowserActivity(directory, { agentKey: "main", agent: "Main agent", action: "open", url: "http://a", title: "A", frame: "frame-main.jpg", at: "1" });
  await appendBrowserActivity(directory, { agentKey: "sub-x", agent: "Tester", action: "open", url: "http://b", at: "2" });
  await appendBrowserActivity(directory, { agentKey: "main", agent: "Main agent", action: "console", at: "3" });
  const all = await readBrowserActivity(directory);
  assert.equal(all.total, 3);
  assert.deepEqual(all.entries.map((entry) => entry.seq), [1, 2, 3]);
  assert.deepEqual(all.agents.map((agent) => [agent.key, agent.url, agent.frame]), [["main", "http://a", "frame-main.jpg"], ["sub-x", "http://b", ""]]);
  assert.deepEqual((await readBrowserActivity(directory, { after: 2 })).entries.map((entry) => entry.action), ["console"]);
  const reset = await readBrowserActivity(directory, { after: 99 });
  assert.equal(reset.reset, true);
  assert.equal(reset.entries.length, 3);
});

test("trims a large log to recent steps", async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ua-activity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const padding = "x".repeat(3000);
  for (let index = 0; index < 500; index++) await appendBrowserActivity(directory, { agentKey: "main", action: "snapshot", detail: padding, n: index });
  const { total, entries } = await readBrowserActivity(directory, { limit: 1000 });
  assert.ok(total < 400);
  assert.equal(entries.at(-1).n, 499);
  const stat = await fs.stat(path.join(directory, "activity.jsonl"));
  assert.ok(stat.size <= 1024 * 1024 + 4000);
});

test("serves only frame and screenshot images from the chat folder", async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ua-activity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "frame-main.jpg"), "jpg");
  await fs.writeFile(path.join(directory, "activity.jsonl"), "{}\n");
  assert.equal(String(await readBrowserImage(directory, "frame-main.jpg")), "jpg");
  for (const name of ["activity.jsonl", "../frame-main.jpg", "frame-../../x.jpg", "screenshot-a.jpg"]) {
    assert.equal(browserImageName.test(name), false, name);
    assert.equal(await readBrowserImage(directory, name), null);
  }
  assert.ok(browserImageName.test("screenshot-1760000000000-main-1.png"));
});
