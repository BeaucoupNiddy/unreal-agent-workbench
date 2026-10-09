import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UnrealAgentBridge } from "../src/bridge.mjs";
import { normalizeAgentSettings, saveAgentSettings, subagentInstructions } from "../src/agent-profiles.mjs";
import { normalizeSwarmRequest, SwarmHub, swarmSystemPrompt } from "../src/swarm.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "fixtures", "swarm-runner.mjs");
const researcher = { name: "Researcher", description: "Outside information", provider: "openai-codex", model: "gpt-6-luna" };
const reviewer = { name: "Reviewer", description: "Independent review", provider: "openai-codex", model: "gpt-6-sol" };
const on = (swarm = {}) => ({ enabled: true, swarm: { enabled: true, ...swarm }, subagents: [researcher, reviewer] });

test("swarm settings are off by default and bounded", () => {
  assert.deepEqual(normalizeAgentSettings({}).swarm, { enabled: false, use: "asked", size: 4, maxMessages: 60, maxWakes: 3 });
  assert.deepEqual(normalizeAgentSettings({ swarm: { enabled: true, use: "always", size: 40, maxMessages: 1, maxWakes: -2 } }).swarm,
    { enabled: true, use: "asked", size: 8, maxMessages: 10, maxWakes: 0 });
});

test("the primary agent hears about swarms only when they are on", () => {
  const text = (settings) => subagentInstructions(normalizeAgentSettings(settings)).join("\n");
  assert.doesNotMatch(text({ enabled: true, subagents: [researcher] }), /swarm/i);
  assert.match(text(on()), /unreal-capability swarm/);
  assert.match(text(on()), /only when the user explicitly asks/);
  assert.match(text(on({ use: "hard" })), /hard problem/);
  assert.match(text(on()), /do not investigate the areas you handed off/);
  assert.doesNotMatch(text({ ...on(), enabled: false }), /swarm/i);
});

test("names members, fills seats from the roster, and enforces the size", () => {
  const agents = normalizeAgentSettings(on()).subagents;
  const plan = normalizeSwarmRequest({ task: "x", agents: ["researcher", "researcher", "reviewer"], angles: ["a", "b"] }, agents, 4);
  assert.deepEqual(plan.members.map((member) => [member.name, member.angle]), [["researcher-1", "a"], ["researcher-2", "b"], ["reviewer", ""]]);
  assert.deepEqual(normalizeSwarmRequest({ task: "x" }, agents, 3).members.map((member) => member.name), ["researcher-1", "reviewer", "researcher-2"]);
  assert.throws(() => normalizeSwarmRequest({ task: "x", agents: ["researcher"] }, agents, 4), /at least two/);
  assert.throws(() => normalizeSwarmRequest({ task: "x", agents: Array(5).fill("reviewer") }, agents, 4), /limited to 4/);
  assert.throws(() => normalizeSwarmRequest({ task: "x", agents: ["researcher", "ghost"] }, agents, 4), /Unknown subagent "ghost"/);
  const prompt = swarmSystemPrompt(plan.members[0], ["researcher-1", "researcher-2", "reviewer"], "read-only");
  assert.match(prompt, /Your peers: researcher-2, reviewer/);
  assert.match(prompt, /end your turn\. A message to you wakes you again/);
  assert.match(prompt, /Never stop processes you did not start/);
});

test("the hub routes broadcast and direct messages within the budget", () => {
  const delivered = [];
  const members = ["a", "b", "c"].map((name) => ({ name, profile: { id: name } }));
  const hub = new SwarmHub({ task: "t", members, maxMessages: 2, onMessage: (member, message) => delivered.push([member.name, message.text]) });
  assert.equal(new SwarmHub({ task: "t", members }).send("a", { message: "hi" }), "Sent to b, c.");
  assert.equal(hub.send("a", { to: "all", message: "hello" }), "Sent to b, c. 1 swarm messages left.");
  assert.match(hub.send("b", { to: "c", message: "just you" }), /Sent to c\. 0 swarm messages left/);
  assert.deepEqual(delivered, [["b", "hello"], ["c", "hello"], ["c", "just you"]]);
  assert.throws(() => hub.send("a", { to: "b", message: "more" }), /budget is used up/);
  assert.throws(() => hub.send("a", { to: "a", message: "x" }), /yourself/);
  assert.throws(() => hub.send("a", { to: "zed", message: "x" }), /No swarm member is named "zed"/);
  assert.match(hub.drain("c"), /\[Swarm message from a to everyone\]\nhello\n\n\[Swarm message from b to you\]\njust you/);
  assert.equal(hub.drain("c"), "No new swarm messages.");
  assert.match(hub.result(), /## Discussion\n- a → all: hello\n- b → c: just you/);
});

async function fixture(settings, { live = true, parent = {} } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "unreal-swarm-"));
  const codexHome = await mkdtemp(path.join(tmpdir(), "unreal-swarm-codex-"));
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "test" } }));
  process.env.CODEX_HOME = codexHome;
  await saveAgentSettings(dataDir, settings);
  const launches = [];
  const bridge = new UnrealAgentBridge({ dataDir, runner, liveRunner: live ? runner : null,
    codexCatalog: { load: async () => ({ models: [], source: "fallback", fetchedAt: 0 }) },
    confinement: async (options) => { launches.push(options); return { command: options.runner, args: options.args }; } });
  const session = { id: "unreal-parent", cwd: dataDir, provider: "openai-codex", model: "gpt-6-astra", permissionMode: "workspace-write",
    writableFolders: [], thoughtLevel: "high", mcpServers: [], ...parent };
  const updates = [];
  session.activeClient = { notify: async (_method, params) => { updates.push(structuredClone(params.update)); } };
  bridge.sessions.set(session.id, session);
  await bridge.capabilityBroker.start();
  const swarm = (request) => bridge.capabilityBroker.handle({ sessionId: session.id, action: "swarm", ...request });
  return { bridge, session, launches, updates, swarm, close: () => bridge.capabilityBroker.close() };
}

for (const live of [true, false]) {
  test(`members exchange findings mid-task (${live ? "live inbox" : "swarm-inbox"})`, async () => {
    const { bridge, session, launches, updates, swarm, close } = await fixture(on(), { live });
    try {
      const result = await swarm({ task: "discuss the bug", agents: ["researcher", "reviewer"] });
      assert.match(result, /^Swarm result \(2 members, 2 messages exchanged\):/);
      assert.match(result, /## researcher\nresearcher heard: \[Swarm message from reviewer to everyone\]\nreviewer found reviewer-fact/);
      assert.match(result, /## reviewer\nreviewer heard: \[Swarm message from researcher to everyone\]\nresearcher found researcher-fact/);
      assert.match(result, /- researcher → all: researcher found researcher-fact/);
      assert.equal(launches.length, 2);
      assert.equal(launches.every((launch) => launch.args.includes("-live-input") === live), true);
      assert.equal(launches.every((launch) => launch.mode === "read-only"), true);
      // Usage lands on the chat, labeled by profile; the members are gone afterwards.
      assert.deepEqual([...new Set(session.usage.events.map((event) => event.agent))].sort(), ["researcher", "reviewer"]);
      assert.equal(bridge.sessions.size, 1);
      assert.equal(session.activeSubagents.size, 0);
      assert.equal(session.activeSwarm, null);
      const card = updates.filter((update) => update._meta?.["unreal-agent/swarm"]);
      assert.equal(card[0].sessionUpdate, "tool_call");
      assert.equal(card.at(-1).status, "completed");
      assert.equal(card.at(-1)._meta["unreal-agent/swarm"].messages.length, 2);
      const members = updates.filter((update) => update._meta?.["unreal-agent/subagent"]?.swarmId);
      assert.equal(new Set(members.map((update) => update.toolCallId)).size, 2);
    } finally { await close(); }
  });
}

test("a message to a member that already finished wakes it, within the limit", async () => {
  for (const [maxWakes, expected] of [[3, /researcher-2 woken by: \[Swarm message from researcher-1 to you\]\nPlease double-check this/], [0, /researcher-2 done early/]]) {
    const { launches, swarm, close } = await fixture(on({ maxWakes }));
    try {
      const result = await swarm({ task: "wake test", agents: ["researcher", "researcher"] });
      assert.match(result, expected);
      assert.equal(launches.length, maxWakes ? 3 : 2);
      if (!maxWakes) assert.match(result, /1 message arrived after its recipient had finished/);
    } finally { await close(); }
  }
});

test("swarms respect settings, block recursion, and Stop ends every member", async () => {
  const off = await fixture({ ...on(), swarm: { enabled: false } });
  await assert.rejects(off.swarm({ task: "x" }), /Swarms are turned off/);
  await off.close();
  const { bridge, session, swarm, close } = await fixture(on());
  try {
    bridge.sessions.set("child", { id: "child", isSubagent: true });
    await assert.rejects(bridge.capabilityBroker.handle({ sessionId: "child", action: "swarm", task: "x" }), /primary agent/);
    await assert.rejects(bridge.capabilityBroker.handle({ sessionId: "child", action: "swarm_send", message: "x" }), /Only swarm members/);
    const running = swarm({ task: "wait for a while", agents: ["researcher", "reviewer"] });
    while ([...(session.activeSubagents || [])].filter((run) => run.child).length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(swarm({ task: "another" }), /already running/);
    bridge.stopTask(session);
    await assert.rejects(running, /swarm was cancelled/);
    assert.equal(session.activeSubagents.size, 0);
  } finally { await close(); }
});

test("a failed member does not sink the swarm", async () => {
  const { swarm, close } = await fixture(on());
  try {
    const result = await swarm({ task: "solo work", agents: ["researcher", "reviewer"], angles: ["", "please fail"] });
    assert.match(result, /## researcher\nresearcher solo/);
    assert.match(result, /## reviewer \(failed\)\nreviewer failed: model unavailable/);
  } finally { await close(); }
});
