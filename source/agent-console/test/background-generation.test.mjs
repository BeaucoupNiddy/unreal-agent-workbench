import test from "node:test";
import assert from "node:assert/strict";
import { cleanGeneratedTitle, parseGeneratedMemory, parseGeneratedText, BackgroundGenerator, readBackgroundConnection } from "../background-generation.mjs";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveLocalProvider } from "../../unreal-agent-acp/src/local-providers.mjs";

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
