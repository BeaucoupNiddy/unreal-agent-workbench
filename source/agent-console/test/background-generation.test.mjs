import test from "node:test";
import assert from "node:assert/strict";
import { cleanGeneratedTitle, parseGeneratedMemory, parseGeneratedText, BackgroundGenerator, readBackgroundConnection } from "../background-generation.mjs";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveLocalProvider } from "../../unreal-agent-acp/src/local-providers.mjs";
import { readAuxiliaryUsage } from "../../unreal-agent-acp/src/auxiliary-usage.mjs";
import { runBackgroundModel } from "../background-generation.mjs";
import { fileURLToPath } from "node:url";

test('background inference disables native tools, requests confinement and saves each usage response once', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'background-ledger-'));
  try {
    let request;
    await runBackgroundModel({ runner: fileURLToPath(new URL('../../unreal-agent-acp/test/fixtures/usage-runner.mjs', import.meta.url)),
      workspace: root, model: 'test', systemPrompt: 'title', prompt: 'topic', usageDataDir: root, purpose: 'title', parentSessionId: 'chat',
      confinement: async ({ mode, runner, args }) => { assert.equal(mode, 'read-only'); request = JSON.parse(args.at(-1)); return { command: runner, args }; } });
    for (const name of ['Bash', 'ViewImage', 'SkillUse']) assert.ok(request.disallowed_tools.includes(name));
    const events = await readAuxiliaryUsage(root);
    assert.equal(events.length, 2);
    assert.equal(events.reduce((total, event) => total + event.inputTokens + event.outputTokens, 0), 350);
    assert.ok(events.every((event) => event.purpose === 'title' && event.parentSessionId === 'chat'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('overlapping and repeated background requests skip unchanged project memory', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'background-coalesce-'));
  let release;
  try {
    const directory = path.join(root, 'chat'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify({ cwd: root }));
    await fs.writeFile(path.join(directory, 'history.jsonl'), JSON.stringify({ params: { update: { sessionUpdate: 'prompt_received', prompt: [{ type: 'text', text: 'Keep the exact filename' }] } } }));
    let calls = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    const generator = new BackgroundGenerator({ hydraSessionRoot: root, memoryRoot: path.join(root, 'memories'), oneOffWorkspace: '/unused',
      readSettings: async () => ({ memoryEnabled: true, memoryModel: 'test' }), updateTitle: async () => {},
      runModel: async () => { calls++; await gate; return '{"goal":"Keep filename","outcome":"Done"}'; } });
    const first = generator.afterPrompt('chat');
    const second = generator.afterPrompt('chat');
    release(); await Promise.all([first, second]); await generator.afterPrompt('chat');
    assert.equal(calls, 1);
  } finally { release?.(); await fs.rm(root, { recursive: true, force: true }); }
});

test("extracts visible model output from runner events", () => {
  const event = { Kind: "model_response", Data: { Response: { Output: [
    { Type: "message", Data: { Phase: "analysis", Text: "hidden" } },
    { Type: "message", Data: { Phase: "message", Text: "Project memory" } }
  ] } } };
  assert.equal(parseGeneratedText(JSON.stringify(event)), "Project memory");
});

test("cleans generated titles", () => {
  assert.equal(cleanGeneratedTitle('Title: "Add Project Memory."\nExtra'), "Add Project Memory");
});

test("normalizes generated memory JSON", () => {
  assert.deepEqual(parseGeneratedMemory('```json\n{"goal":"Ship it","outcome":"Done","rejected_approaches":["Global context"],"open_threads":["Tests"]}\n```'), {
    goal: "Ship it", outcome: "Done", rejectedApproaches: ["Global context"], openThreads: ["Tests"]
  });
});

test("local titles and project memory use the chat's model and server instead of cloud generation settings", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "local-background-"));
  const dataDir = path.join(root, "agent"), sessionRoot = path.join(root, "hydra"), memoryRoot = path.join(root, "memory");
  const upstream = "local-chat", id = "hydra-chat", cwd = path.join(root, "workspace");
  const metadata = path.join(dataDir, "metadata", `${createHash("sha256").update(upstream).digest("hex")}.json`);
  try {
    const saved = await saveLocalProvider(dataDir, { type: "omlx", name: "Local", baseUrl: "http://localhost:8000/v1", apiKey: "background-test-key" });
    await fs.mkdir(path.dirname(metadata), { recursive: true });
    await fs.writeFile(metadata, JSON.stringify({ provider: saved.id, model: "qwen-local", localConnection: saved }));
    await fs.mkdir(path.join(sessionRoot, id), { recursive: true });
    await fs.writeFile(path.join(sessionRoot, id, "meta.json"), JSON.stringify({ cwd, upstreamSessionId: upstream }));
    await fs.writeFile(path.join(sessionRoot, id, "history.jsonl"), JSON.stringify({ params: { update: { sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "Private local conversation" }] } } }));
    const requests = [], titles = [];
    const generator = new BackgroundGenerator({ hydraSessionRoot: sessionRoot, memoryRoot, oneOffWorkspace: path.join(root, "one-off"),
      readSettings: async () => ({ memoryEnabled: true, titleEnabled: true, memoryModel: "gpt-6-luna", titleModel: "gpt-6-luna" }),
      readConnection: (meta) => readBackgroundConnection(dataDir, meta.upstreamSessionId),
      updateTitle: async (_, title) => titles.push(title),
      runModel: async (request) => { requests.push(request); return request.systemPrompt.includes("chat title") ? "Local Chat Title" : '{"goal":"Private goal","outcome":"Done"}'; }
    });
    assert.deepEqual(await generator.generate(id, { generateTitle: true }), { generated: 2 });
    for (const request of requests) {
      assert.equal(request.model, "qwen-local");
      assert.equal(request.environment.UNREAL_HARNESS_LLM_PROVIDER, "openai");
      assert.equal(request.environment.UNREAL_HARNESS_LLM_BASE_URL, process.env.UNREAL_HARNESS_LLM_BASE_URL || saved.baseUrl);
      assert.equal(request.environment.UNREAL_HARNESS_LLM_API_KEY, process.env.UNREAL_HARNESS_LLM_API_KEY || "background-test-key");
      assert.match(request.prompt, /Private local conversation/);
    }
    assert.deepEqual(titles, ["Local Chat Title"]);
    const memory = await fs.readFile(path.join(memoryRoot, `${id}.json`), "utf8");
    assert.equal(JSON.parse(memory).model, "qwen-local");
    assert.equal(memory.includes("background-test-key"), false);
    await saveLocalProvider(dataDir, { ...saved, baseUrl: "http://localhost:9000/v1", apiKey: "changed-key" });
    if (!process.env.UNREAL_HARNESS_LLM_BASE_URL && !process.env.UNREAL_HARNESS_LLM_API_KEY) {
      await assert.rejects(generator.generate(id, { generateTitle: true }), /local connection changed/i);
      assert.equal(requests.length, 2);
    }
    await fs.writeFile(metadata, JSON.stringify({ provider: "openrouter", model: "vendor/model" }));
    assert.equal(await readBackgroundConnection(dataDir, upstream), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a failed memory summary does not prevent a saved title or re-title on the next turn", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "title-memory-"));
  const id = "hydra_session_test", cwd = path.join(root, "workspace"), titles = [];
  try {
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(path.join(root, id, "meta.json"), JSON.stringify({ cwd, title: "Raw first prompt" }));
    await fs.writeFile(path.join(root, id, "history.jsonl"), JSON.stringify({ params: { update: { sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "Raw first prompt" }] } } }));
    const generator = new BackgroundGenerator({ hydraSessionRoot: root, memoryRoot: path.join(root, "memory"), oneOffWorkspace: path.join(root, "oneoff"),
      readSettings: async () => ({ titleEnabled: true, memoryEnabled: true, titleModel: "test", memoryModel: "test" }),
      updateTitle: async (_, title) => titles.push(title),
      runModel: async ({ systemPrompt }) => { if (systemPrompt.includes("chat title")) return "Concise New Title"; throw new Error("memory quota exhausted"); }
    });
    const warn = console.warn;
    console.warn = () => {};
    try { assert.deepEqual(await generator.afterPrompt(id, { generateTitle: true }), { generated: 1 }); }
    finally { console.warn = warn; }
    assert.deepEqual(titles, ["Concise New Title"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("empty generated titles fail so the scheduler can retry", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "empty-title-"));
  const id = "hydra_session_test";
  try {
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(path.join(root, id, "meta.json"), JSON.stringify({ cwd: root }));
    await fs.writeFile(path.join(root, id, "history.jsonl"), JSON.stringify({ params: { update: { sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "Something" }] } } }));
    const generator = new BackgroundGenerator({ hydraSessionRoot: root, memoryRoot: root, oneOffWorkspace: root,
      readSettings: async () => ({ titleEnabled: true, memoryEnabled: false, titleModel: "test" }),
      updateTitle: async () => assert.fail("should not save an empty title"), runModel: async () => "```" });
    await assert.rejects(generator.afterPrompt(id, { generateTitle: true }), /empty title/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('shared steering completions schedule background work once and Stop does not schedule it', async () => {
  const { shouldGenerateAfterPrompt } = await import('../background-generation.mjs');
  const completed = { stopReason: 'end_turn' };
  assert.equal(shouldGenerateAfterPrompt(completed, 2), false);
  assert.equal(shouldGenerateAfterPrompt(completed, 1), false);
  assert.equal(shouldGenerateAfterPrompt(completed, 0), true);
  assert.equal(shouldGenerateAfterPrompt({ stopReason: 'cancelled' }, 0), false);
  assert.equal(shouldGenerateAfterPrompt({ stopReason: 'steered' }, 0), false);
});
