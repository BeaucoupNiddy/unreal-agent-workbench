import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UnrealAgentBridge } from "../src/bridge.mjs";
import { delegationLevels, normalizeAgentSettings, readAgentSettings, saveAgentSettings, subagentInstructions, subagentPermission } from "../src/agent-profiles.mjs";
import { boundedReport, claudeSubagentArgs, normalizeDelegation, subagentReport } from "../src/subagents.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const explorer = { name: "Explorer", description: "Broad read-only searches", provider: "openai-codex", model: "gpt-6-luna" };
const worker = { name: "Worker", description: "Separable edits", provider: "openai-codex", model: "gpt-6-sol", access: "workspace-write" };

test("normalizes subagent settings with safe defaults", () => {
  const settings = normalizeAgentSettings({ enabled: true, maxConcurrent: 40, subagents: [explorer, { ...worker, thoughtLevel: "low" }] });
  assert.equal(settings.maxConcurrent, 8);
  assert.deepEqual(settings.subagents.map((agent) => [agent.id, agent.access, agent.enabled]),
    [["explorer", "read-only", true], ["worker", "workspace-write", true]]);
  assert.equal(settings.subagents[1].thoughtLevel, "low");
  assert.deepEqual(normalizeAgentSettings({}), { enabled: false, maxConcurrent: 3, delegation: 3,
    swarm: { enabled: false, use: "asked", size: 4, maxMessages: 60, maxWakes: 3 }, subagents: [] });
  assert.equal(normalizeAgentSettings({ delegation: 9 }).delegation, 5);
  assert.equal(normalizeAgentSettings({ delegation: 'often' }).delegation, 3);
  assert.throws(() => normalizeAgentSettings({ subagents: [explorer, explorer] }), /Two subagents/);
  assert.throws(() => normalizeAgentSettings({ subagents: [{ ...explorer, provider: "nope" }] }), /valid provider/);
  assert.throws(() => normalizeAgentSettings({ subagents: [{ ...explorer, description: "" }] }), /use when/);
  assert.throws(() => normalizeAgentSettings({ subagents: [{ ...explorer, access: "danger-full-access" }] }), /Read only or Workspace/);
});

test("stores settings privately and treats a damaged file as delegation off", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "unreal-agents-"));
  await saveAgentSettings(dataDir, { enabled: true, subagents: [explorer] });
  assert.equal((await stat(path.join(dataDir, "agents.json"))).mode & 0o777, 0o600);
  assert.equal((await readAgentSettings(dataDir)).subagents[0].id, "explorer");
  await writeFile(path.join(dataDir, "agents.json"), "{broken");
  assert.equal((await readAgentSettings(dataDir)).enabled, false);
});

test("subagents never exceed the chat's permission and are never unsandboxed", () => {
  assert.equal(subagentPermission("read-only", "workspace-write"), "read-only");
  assert.equal(subagentPermission("workspace-write", "read-only"), "read-only");
  assert.equal(subagentPermission("workspace-write", "workspace-write"), "workspace-write");
  assert.equal(subagentPermission("danger-full-access", "workspace-write"), "workspace-write");
});

test("adds delegation guidance only when enabled subagents exist", () => {
  assert.deepEqual(subagentInstructions(normalizeAgentSettings({ subagents: [explorer] })), []);
  assert.deepEqual(subagentInstructions(normalizeAgentSettings({ enabled: true, subagents: [{ ...explorer, enabled: false }] })), []);
  const lines = subagentInstructions(normalizeAgentSettings({ enabled: true, subagents: [explorer, worker] }));
  assert.match(lines[0], /explorer \(read only\): Broad read-only searches/);
  assert.match(lines[0], /worker \(can edit\)/);
  assert.match(lines[1], /unreal-capability delegate/);
  assert.match(lines[1], /at most 3 at once/);
});

test("the delegation level sets how readily the primary agent delegates", () => {
  const lines = (delegation) => subagentInstructions(normalizeAgentSettings({ enabled: true, delegation, subagents: [explorer] })).join("\n");
  assert.match(lines(1), /only when the user explicitly asks/);
  assert.match(lines(3), /saves meaningful work/);
  assert.match(lines(5), /Act as a coordinator/);
  assert.match(lines(5), /Never give two editing subagents overlapping files/);
  assert.deepEqual(delegationLevels.map((item) => item.level), [1, 2, 3, 4, 5]);
});

test("extracts the last visible report and bounds it", () => {
  const line = (text, phase = "final") => JSON.stringify({ Kind: "model_response", Data: { Response: { Output: [{ Type: "message", Data: { Phase: phase, Text: text } }] } } });
  assert.equal(subagentReport([line("Starting."), "not json", line("thinking", "analysis"), line("Final report.")].join("\n")), "Final report.");
  const compaction = JSON.stringify({ Kind: "turn", Data: { ID: "c1", Type: "compaction" } });
  const summary = JSON.stringify({ Kind: "model_response", Data: { TurnID: "c1", Response: { Output: [{ Type: "message", Data: { Text: "Handoff summary" } }] } } });
  assert.equal(subagentReport([line("Final report."), compaction, summary].join("\n")), "Final report.");
  assert.match(boundedReport("x".repeat(9000)), /truncated at 8000/);
  assert.throws(() => normalizeDelegation({ task: "x" }), /Name the subagent/);
  assert.throws(() => normalizeDelegation({ agent: "a", task: "x".repeat(20001) }), /under 20000/);
  const args = claudeSubagentArgs({ sessionId: "id", model: "haiku", permissionMode: "read-only", systemPrompt: "role", prompt: "task" });
  assert.deepEqual(args.slice(args.indexOf("--disallowedTools")), ["--disallowedTools", "Edit", "Write", "NotebookEdit"]);
});

async function fixture(settings, parent = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "unreal-subagent-"));
  const codexHome = await mkdtemp(path.join(tmpdir(), "unreal-subagent-codex-"));
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "test" } }));
  process.env.CODEX_HOME = codexHome;
  const record = path.join(dataDir, "record.json");
  process.env.SUBAGENT_RECORD = record;
  await saveAgentSettings(dataDir, settings);
  const launches = [];
  const bridge = new UnrealAgentBridge({ dataDir, runner: path.join(here, "fixtures", "subagent-runner.mjs"), liveRunner: null,
    codexCatalog: { load: async () => ({ models: [], source: "fallback", fetchedAt: 0 }) },
    confinement: async (options) => { launches.push(options); return { command: options.runner, args: options.args }; } });
  const session = { id: "unreal-parent", cwd: dataDir, provider: "openai-codex", model: "gpt-6-astra", permissionMode: "workspace-write",
    writableFolders: ["/approved"], thoughtLevel: "high", mcpServers: [], ...parent };
  bridge.sessions.set(session.id, session);
  const delegate = (request) => bridge.capabilityBroker.handle({ sessionId: session.id, action: "delegate", ...request });
  return { bridge, session, launches, record, delegate };
}

test("delegates to a sandboxed read-only subagent and returns only its report", async () => {
  const { bridge, session, launches, record, delegate } = await fixture({ enabled: true, subagents: [explorer] });
  const result = await delegate({ agent: "explorer", task: "Find the config loader", context: "Start in src/" });
  assert.match(result, /^Explorer subagent report \(openai-codex\/gpt-6-luna, read only\):/);
  assert.match(result, /Report for: Find the config loader\n\nContext from the primary agent:\nStart in src\//);
  assert.doesNotMatch(result, /Looking around/);
  assert.match(result, /300 input, 30 output tokens/);
  assert.equal(launches[0].mode, "read-only");
  assert.deepEqual(launches[0].writableFolders, []);
  const recorded = JSON.parse(await readFile(record, "utf8"));
  assert.equal(recorded.model, "gpt-6-luna");
  assert.match(recorded.sessionId, /^unreal-parent-sub-/);
  assert.match(recorded.request.system_prompt, /"Explorer" subagent/);
  assert.match(recorded.request.system_prompt, /read-only/);
  assert.match(recorded.request.system_prompt, /Never stop processes you did not start/);
  assert.equal(recorded.args.includes("-live-input"), false);
  // Usage belongs to the parent chat, counted once per response and labeled.
  assert.equal(session.usage.inputTokens, 300);
  assert.deepEqual(session.usage.events.map((event) => [event.purpose, event.agent]), [["subagent", "explorer"], ["subagent", "explorer"]]);
  assert.equal(bridge.sessions.size, 1);
  assert.equal(session.activeSubagents.size, 0);
});

test("editing subagents inherit approved folders but follow a read-only chat", async () => {
  const { launches, delegate, session } = await fixture({ enabled: true, subagents: [worker] });
  await delegate({ agent: "worker", task: "Edit one file" });
  assert.equal(launches[0].mode, "workspace-write");
  assert.deepEqual(launches[0].writableFolders, ["/approved"]);
  session.permissionMode = "read-only";
  await delegate({ agent: "worker", task: "Edit one file" });
  assert.equal(launches[1].mode, "read-only");
});

test("rejects disabled, unknown, and recursive delegation, and reports failures", async () => {
  const off = await fixture({ enabled: false, subagents: [explorer] });
  await assert.rejects(off.delegate({ agent: "explorer", task: "x" }), /turned off/);
  const { bridge, delegate } = await fixture({ enabled: true, subagents: [explorer] });
  await assert.rejects(delegate({ agent: "missing", task: "x" }), /Unknown subagent "missing". Available: explorer/);
  bridge.sessions.set("child", { id: "child", isSubagent: true });
  for (const action of ["delegate", "agents", "plan", "request_write"]) {
    await assert.rejects(bridge.capabilityBroker.handle({ sessionId: "child", action, agent: "explorer", task: "x" }), /primary agent/);
  }
  await assert.rejects(delegate({ agent: "explorer", task: "please fail" }), /failed: model unavailable/);
  const listed = await bridge.capabilityBroker.handle({ sessionId: "unreal-parent", action: "agents" });
  assert.deepEqual(listed.map((agent) => [agent.id, agent.access]), [["explorer", "read-only"]]);
});

test("the chat gets a live view of each subagent, ending with its report", async () => {
  const { session, delegate } = await fixture({ enabled: true, subagents: [explorer] });
  const updates = [];
  session.activeClient = { notify: async (_method, params) => { updates.push(structuredClone(params.update)); } };
  await delegate({ agent: "explorer", task: "Map the config loader with steps" });
  const view = updates.filter((update) => update._meta?.["unreal-agent/subagent"]);
  assert.equal(view[0].sessionUpdate, "tool_call");
  assert.match(view[0].title, /^Explorer · Map the config loader/);
  assert.equal(view[0]._meta["unreal-agent/subagent"].status, "running");
  const last = view.at(-1);
  assert.equal(last.sessionUpdate, "tool_call_update");
  assert.equal(last.toolCallId, view[0].toolCallId);
  assert.equal(last.status, "completed");
  const state = last._meta["unreal-agent/subagent"];
  assert.equal(state.status, "completed");
  assert.equal(state.model, "gpt-6-luna");
  assert.deepEqual(state.steps, [{ id: "call-1", title: state.steps[0].title, status: "completed" }]);
  assert.match(state.steps[0].title, /rg loadConfig src/);
  assert.equal(state.inputTokens, 310);
  assert.ok(Math.abs(state.cost - 0.0031) < 1e-9);
  assert.ok(state.endedAt >= state.startedAt);
  assert.match(last.content[0].content.text, /Report for: Map the config loader/);
});

test("a failed subagent's view ends as failed with the error", async () => {
  const { session, delegate } = await fixture({ enabled: true, subagents: [explorer] });
  const updates = [];
  session.activeClient = { notify: async (_method, params) => { updates.push(structuredClone(params.update)); } };
  await assert.rejects(delegate({ agent: "explorer", task: "please fail" }), /model unavailable/);
  const last = updates.filter((update) => update._meta?.["unreal-agent/subagent"]).at(-1);
  assert.equal(last.status, "failed");
  assert.equal(last._meta["unreal-agent/subagent"].status, "failed");
  assert.match(last._meta["unreal-agent/subagent"].error, /model unavailable/);
});

test("a plan subagent does not hide the chat's API charges", async () => {
  const { session, delegate } = await fixture({ enabled: true, subagents: [explorer] }, { provider: "openrouter", model: "vendor/model" });
  session.usage = { inputTokens: 50, outputTokens: 5, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0,
    cost: 0.5, costKnown: true, responses: ["main-1"], lastContextTokens: 0, events: [] };
  await delegate({ agent: "explorer", task: "Search with a plan model" });
  assert.equal(session.usage.costKnown, true);
  assert.equal(session.usage.cost, 0.5);
  assert.deepEqual(session.usage.events.map((event) => [event.provider, event.purpose, event.cost]),
    [["openai-codex", "subagent", null], ["openai-codex", "subagent", null]]);
});

test("limits concurrent subagents and Stop cancels running ones", async () => {
  const { bridge, session, delegate } = await fixture({ enabled: true, maxConcurrent: 1, subagents: [explorer] });
  const running = delegate({ agent: "explorer", task: "wait for a while" });
  while (!session.activeSubagents?.size || ![...session.activeSubagents][0].child) await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(delegate({ agent: "explorer", task: "second" }), /1 subagents are already running/);
  bridge.stopTask(session);
  await assert.rejects(running, /Explorer subagent was cancelled/);
  assert.equal(session.activeSubagents.size, 0);
});

test("the primary agent's prompt lists enabled subagents", async () => {
  const { bridge, record } = await fixture({ enabled: true, subagents: [explorer] });
  bridge.capabilityBroker = { server: {}, start: async () => {}, warm: () => {}, closeSession: () => {}, cancelSession: () => {} };
  const created = await bridge.newSession({ cwd: here, mcpServers: [] });
  // Pin the provider: newSession otherwise follows this Mac's saved provider settings.
  Object.assign(bridge.sessions.get(created.sessionId), { provider: "openai-codex", model: "gpt-6-astra",
    permissionMode: "danger-full-access", fullAccessApproved: true });
  await bridge.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hello" }] }, { notify: async () => {} });
  const recorded = JSON.parse(await readFile(record, "utf8"));
  assert.match(recorded.request.system_prompt, /Subagents are available: explorer \(read only\)/);
});

test("the helper commands named in prompts exist and explain themselves", async () => {
  const { execFile } = await import("node:child_process");
  const run = (file, args, input) => new Promise((resolve) => {
    const child = execFile(path.join(here, "..", "bin", file), args, { cwd: here }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
  const help = await run("unreal-capability", ["swarm", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /unreal-capability swarm '/);
  assert.match(help.stdout, /plan '\[\{"content":"step"/);
  const patch = await run("unreal-apply-patch", [], "");
  assert.match(patch.stderr, /Usage: unreal-apply-patch/);
});

test("the capability CLI delegates over the session socket", async () => {
  const { execFile } = await import("node:child_process");
  const { bridge, session } = await fixture({ enabled: true, subagents: [explorer] });
  await bridge.capabilityBroker.start();
  try {
    const output = await new Promise((resolve, reject) => execFile(path.join(here, "..", "bin", "unreal-capability.mjs"),
      ["delegate", JSON.stringify({ agent: "explorer", task: "Summarize README" })],
      { env: { ...process.env, UNREAL_AGENT_CAPABILITY_SOCKET: bridge.capabilitySocket, UNREAL_AGENT_SESSION_ID: session.id } },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
    assert.match(output, /Report for: Summarize README/);
  } finally { await bridge.capabilityBroker.close(); }
});
