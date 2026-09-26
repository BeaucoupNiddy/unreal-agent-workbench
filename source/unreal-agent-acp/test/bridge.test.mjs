import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acp, capabilityInstructions, contentBlocksToPrompt, createAgentApp, formatTokenCount, formatUsageCost, orderModelOptions, parseHarnessEvent, parseOpenRouterModelCatalog, UnrealAgentBridge } from "../src/bridge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("converts ACP text and resources into a harness prompt", () => {
  assert.equal(contentBlocksToPrompt([
    { type: "text", text: "Review this" },
    { type: "resource_link", name: "app.js", uri: "file:///tmp/app.js" },
    { type: "resource", resource: { uri: "file:///tmp/readme.md", text: "# Hello" } }
  ]), "Review this\n\n[Referenced resource: app.js]\nfile:///tmp/app.js\n\n[Attached context: file:///tmp/readme.md]\n# Hello");
});

test("adds concise web policy only when a web capability is present", () => {
  assert.deepEqual(capabilityInstructions([]), []);
  assert.equal(capabilityInstructions([{ name: "github" }]).length, 1);
  const instructions = capabilityInstructions([{ name: "parallel-search", url: "https://search.parallel.ai/mcp" }]);
  assert.equal(instructions.length, 2);
  assert.match(instructions[1], /web-search/);
  assert.match(instructions[1], /ONE call/);
  assert.match(instructions[1], /primary sources/);
  assert.match(instructions[1], /cite their URLs/);
  assert.match(instructions[1], /Skip web search/);
});

test("adds a compact direct route only when Apple productivity is present", () => {
  assert.equal(capabilityInstructions([{ name: "parallel-search" }]).some((line) => line.includes("calendar_today")), false);
  const instructions = capabilityInstructions([{ name: "apple-productivity" }]);
  assert.equal(instructions.some((line) => line.includes("calendar_today")), true);
  assert.equal(instructions.some((line) => line.includes("do not retry")), true);
});

test("maps harness responses and tool activity", () => {
  const response = parseHarnessEvent({
    Kind: "model_response",
    Data: { Response: { Output: [
      { Type: "message", Data: { Text: "Done", Phase: "final" } },
      { Type: "tool_call", Data: { CallID: "call-1", Name: "Bash", Arguments: "{\"command\":\"npm test\"}" } }
    ] } }
  });
  assert.equal(response[0].text, "Done");
  assert.deepEqual(response[1], {
    kind: "tool_start",
    id: "call-1",
    title: "npm test",
    toolKind: "execute",
    rawInput: { command: "npm test" }
  });
  assert.deepEqual(parseHarnessEvent({
    Kind: "tool_call_status",
    Data: { CallID: "call-1", Status: { Error: "" }, Operations: [{ ID: "op-1", Type: "shell", Status: "completed" }] }
  })[0], {
    kind: "tool_update", id: "call-1", status: "completed", error: undefined,
    output: undefined, exitCode: undefined
  });
});

test("normalizes, sorts, and prioritizes the OpenRouter model catalog", () => {
  const models = parseOpenRouterModelCatalog({ data: [
    {
      id: "vendor/text-model",
      name: "Vendor: Text Model",
      context_length: 128000,
      architecture: { output_modalities: ["text"] },
      supported_parameters: ["tools"],
      pricing: { prompt: "0.00000015", completion: "0.0000006" }
    },
    {
      id: "openai/gpt-6-luna",
      name: "OpenAI: GPT-6 Luna",
      context_length: 1000000,
      architecture: { output_modalities: ["text"] },
      supported_parameters: ["tools"],
      pricing: { prompt: "0", completion: "0.0000035" }
    },
    {
      id: "vendor/image-only",
      name: "Vendor: Image Only",
      architecture: { output_modalities: ["image"] }
    }
  ] });
  assert.deepEqual(models.map((model) => model.value), ["openai/gpt-6-luna", "vendor/text-model"]);
  assert.equal(models[0].name, "OpenAI: GPT-6 Luna · $0 in / $3.5 out per 1M tokens");
  assert.equal(models[1].name, "Vendor: Text Model · $0.15 in / $0.6 out per 1M tokens");
  assert.equal(models[1].description, "$0.15 in / $0.6 out per 1M tokens • Tool calling • 128K context");
});

test("does not invent missing or invalid OpenRouter prices", () => {
  const models = parseOpenRouterModelCatalog({ data: [
    { id: "vendor/unknown", name: "Unknown", pricing: { prompt: "  ", completion: "NaN" } },
    { id: "vendor/partial", name: "Partial", pricing: { prompt: "0.000000001" } },
    { id: "vendor/tiny", name: "Tiny", pricing: { prompt: "0.0000000000001", completion: "-1" } }
  ] });
  assert.equal(models.find((model) => model.value === "vendor/unknown").name, "Unknown");
  assert.equal(models.find((model) => model.value === "vendor/partial").name, "Partial · $0.001 in per 1M tokens");
  assert.equal(models.find((model) => model.value === "vendor/tiny").name, "Tiny · <$0.000001 in per 1M tokens");
});

test("stars only user favorites, keeps recommendations next, and removes legacy catalog stars", () => {
  const options = orderModelOptions([
    { value: "other", name: "Other" },
    { value: "recommended", name: "★ Recommended", favorite: true },
    { value: "favorite", name: "Favorite" }
  ], { favorites: ["favorite"], recommended: ["recommended", "favorite"] });
  assert.deepEqual(options.map((option) => option.value), ["favorite", "recommended", "other"]);
  assert.deepEqual(options.map((option) => option.name), ["★ Favorite", "Recommended", "Other"]);
  assert.equal(options[0].favorite, true);
  assert.equal(options[0].recommended, true);
  assert.equal(options[1].favorite, undefined);
  assert.equal(options[1].recommended, true);
});

test("loads and exposes the live OpenRouter catalog in the model picker", async () => {
  const previousProvider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  const previousModel = process.env.UNREAL_HARNESS_LLM_MODEL;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openrouter";
  process.env.UNREAL_HARNESS_LLM_MODEL = "vendor/coder";
  try {
    const dataDir = await mkdtemp(path.join(tmpdir(), "unreal-agent-acp-catalog-test-"));
    const bridge = new UnrealAgentBridge({
      dataDir,
      fetch: async () => ({
        ok: true,
        json: async () => ({ data: [{
          id: "vendor/coder",
          name: "Vendor: Coder",
          architecture: { output_modalities: ["text"] },
          supported_parameters: ["tools"],
          pricing: { prompt: "0.0000002", completion: "0.0000008" }
        }] })
      })
    });
    const created = await bridge.newSession({ cwd: here, mcpServers: [] });
    const modelOption = created.configOptions.find((option) => option.id === "model");
    assert.deepEqual(modelOption.options.map((option) => option.value), ["vendor/coder"]);
    assert.equal(modelOption.currentValue, "vendor/coder");
    assert.equal(modelOption.options[0].name, "Vendor: Coder · $0.2 in / $0.8 out per 1M tokens");
    const updated = await bridge.setConfigOption({ sessionId: created.sessionId, configId: "model", value: "vendor/coder" });
    assert.equal(updated.configOptions[0].options[0].value, "vendor/coder");
    assert.match(updated.configOptions[0].options[0].description, /\$0.2 in \/ \$0.8 out per 1M tokens/);
  } finally {
    if (previousProvider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.UNREAL_HARNESS_LLM_MODEL;
    else process.env.UNREAL_HARNESS_LLM_MODEL = previousModel;
  }
});

test("refreshes old price-less OpenRouter cache entries", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "unreal-agent-acp-old-catalog-"));
  await writeFile(path.join(dataDir, "openrouter-models.json"), JSON.stringify({
    fetchedAt: Date.now(),
    models: [{ value: "vendor/coder", name: "Old name" }]
  }));
  let requests = 0;
  const bridge = new UnrealAgentBridge({ dataDir, fetch: async () => {
    requests++;
    return { ok: true, json: async () => ({ data: [{
      id: "vendor/coder", name: "New name", pricing: { prompt: "0.000001", completion: "0.000002" }
    }] }) };
  } });
  const models = await bridge.loadOpenRouterModels();
  assert.equal(requests, 1);
  assert.equal(models[0].name, "New name · $1 in / $2 out per 1M tokens");
  await bridge.loadOpenRouterModels();
  assert.equal(requests, 1);
});

test("pins favorite models above recommended ones in the model picker", async () => {
  const previousProvider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  const previousModel = process.env.UNREAL_HARNESS_LLM_MODEL;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openrouter";
  process.env.UNREAL_HARNESS_LLM_MODEL = "openai/gpt-6-luna";
  try {
    const dataDir = await mkdtemp(path.join(tmpdir(), "unreal-agent-acp-model-favorites-"));
    // Older installations may still have a removed-recommendations file on disk.
    await writeFile(path.join(dataDir, "openrouter-favorites.json"), JSON.stringify({ removed: ["anthropic/claude-sonnet-5"] }));
    const fetch = async () => ({ ok: true, json: async () => ({ data: [
      { id: "vendor/alpha", name: "Alpha" },
      { id: "openai/gpt-6-luna", name: "Luna", pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "anthropic/claude-sonnet-5", name: "Sonnet" }
    ] }) });
    const bridge = new UnrealAgentBridge({ dataDir, fetch });
    const created = await bridge.newSession({ cwd: here });
    const choices = (result) => result.configOptions.find((option) => option.id === "model");
    const noFavoritesConfig = (result) => assert.ok(!result.configOptions.some((option) => option.id === "favorites"));
    noFavoritesConfig(created);
    assert.deepEqual(choices(created).options.map((item) => item.value), [
      "openai/gpt-6-luna", "anthropic/claude-sonnet-5", "vendor/alpha"
    ]);
    assert.ok(choices(created).options[0].recommended);
    assert.ok(!choices(created).options[0].favorite);
    assert.equal(choices(created).options[0].name, "Luna · $1 in / $2 out per 1M tokens");
    await assert.rejects(bridge.setConfigOption({
      sessionId: created.sessionId, configId: "favorites", value: "remove:openai/gpt-6-luna"
    }), /Unknown configuration option/);

    const updated = await bridge.setConfigOption({
      sessionId: created.sessionId, configId: "favorite_model", value: "anthropic/claude-sonnet-5"
    });
    noFavoritesConfig(updated);
    assert.deepEqual(choices(updated).options.map((item) => item.value), [
      "anthropic/claude-sonnet-5", "openai/gpt-6-luna", "vendor/alpha"
    ]);
    assert.equal(choices(updated).options[0].favorite, true);
    assert.equal(choices(updated).options[0].name, "★ Sonnet");
    assert.equal(choices(updated).options[1].recommended, true);
    assert.equal(choices(updated).options[1].name, "Luna · $1 in / $2 out per 1M tokens");
    assert.equal(choices(updated).currentValue, "openai/gpt-6-luna");
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "model-favorites.json"), "utf8")), ["anthropic/claude-sonnet-5"]);
    await assert.rejects(bridge.setConfigOption({
      sessionId: created.sessionId, configId: "favorite_model", value: "vendor/not-in-catalog"
    }), /Unsupported model selection/);

    const other = await bridge.newSession({ cwd: here });
    assert.equal(choices(other).options[0].favorite, true);

    const removed = await bridge.setConfigOption({
      sessionId: created.sessionId, configId: "favorite_model", value: "anthropic/claude-sonnet-5"
    });
    assert.deepEqual(choices(removed).options.map((item) => item.value), [
      "openai/gpt-6-luna", "anthropic/claude-sonnet-5", "vendor/alpha"
    ]);
    assert.ok(choices(removed).options[1].recommended);
    assert.ok(!choices(removed).options[1].favorite);

    await Promise.all([
      bridge.setConfigOption({ sessionId: created.sessionId, configId: "favorite_model", value: "vendor/alpha" }),
      bridge.setConfigOption({ sessionId: other.sessionId, configId: "favorite_model", value: "openai/gpt-6-luna" })
    ]);
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "model-favorites.json"), "utf8")),
      ["vendor/alpha", "openai/gpt-6-luna"]);
    const restarted = new UnrealAgentBridge({ dataDir, fetch });
    const resumed = await restarted.resumeSession({ sessionId: created.sessionId, cwd: here });
    assert.deepEqual(choices(resumed).options.map((item) => item.value), [
      "vendor/alpha", "openai/gpt-6-luna", "anthropic/claude-sonnet-5"
    ]);
    assert.equal(choices(resumed).options[0].favorite, true);
    assert.equal(choices(resumed).options[1].name, "★ Luna · $1 in / $2 out per 1M tokens");
    assert.equal(choices(resumed).currentValue, "openai/gpt-6-luna");
    assert.equal(choices(resumed).options[0].name, "★ Alpha");
  } finally {
    if (previousProvider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.UNREAL_HARNESS_LLM_MODEL;
    else process.env.UNREAL_HARNESS_LLM_MODEL = previousModel;
  }
});

test("keeps a custom selected model below favorites unless it is favorited", async () => {
  const previousProvider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  const previousModel = process.env.UNREAL_HARNESS_LLM_MODEL;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  process.env.UNREAL_HARNESS_LLM_MODEL = "my-custom-model";
  try {
    const dataDir = await mkdtemp(path.join(tmpdir(), "unreal-agent-acp-custom-favorite-"));
    const bridge = new UnrealAgentBridge({ dataDir });
    const session = await bridge.newSession({ cwd: here });
    const choices = (result) => result.configOptions.find((option) => option.id === "model");
    assert.equal(choices(session).options[0].name, "GPT-6 Astra");
    assert.equal(choices(session).options.at(-1).name, "Current custom: my-custom-model");
    const favorite = await bridge.setConfigOption({
      sessionId: session.sessionId, configId: "favorite_model", value: "my-custom-model"
    });
    assert.equal(choices(favorite).options[0].name, "★ Current custom: my-custom-model");
    assert.equal(choices(favorite).currentValue, "my-custom-model");
  } finally {
    if (previousProvider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.UNREAL_HARNESS_LLM_MODEL;
    else process.env.UNREAL_HARNESS_LLM_MODEL = previousModel;
  }
});

test("runs a complete prompt and emits ACP updates", async () => {
  const previousProvider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  const previousModel = process.env.UNREAL_HARNESS_LLM_MODEL;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  process.env.UNREAL_HARNESS_LLM_MODEL = "gpt-6-astra";
  try {
    const dataDir = await mkdtemp(path.join(tmpdir(), "unreal-agent-acp-test-"));
    const bridge = new UnrealAgentBridge({
      runner: path.join(here, "fixtures", "mock-runner.mjs"),
      dataDir
    });
    bridge.capabilityBroker = { server: {}, start: async () => {}, warm: () => {}, closeSession: () => {} };
    const created = await bridge.newSession({ cwd: here, mcpServers: [] });
    const modelOption = created.configOptions.find((option) => option.id === "model");
    assert.equal(modelOption.category, "model");
    assert.equal(modelOption.currentValue, "gpt-6-astra");
    assert.ok(modelOption.options.every((option) => typeof option.value === "string"));
    assert.ok(modelOption.options.some((option) => option.value === "gpt-6-luna"));
    const changed = await bridge.setConfigOption({ sessionId: created.sessionId, configId: "model", value: "gpt-5.6-luna" });
    assert.equal(changed.configOptions.find((option) => option.id === "model").currentValue, "gpt-5.6-luna");
    bridge.sessions.get(created.sessionId).permissionMode = "danger-full-access";
    bridge.sessions.get(created.sessionId).fullAccessApproved = true;
    const notifications = [];
    const result = await bridge.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "hello" }]
    }, {
      notify: async (_method, params) => notifications.push(params.update)
    });

    assert.deepEqual(result, { stopReason: "end_turn" });
    assert.deepEqual(notifications.map((item) => item.sessionUpdate), [
      "tool_call", "tool_call_update", "agent_message_chunk"
    ]);
    assert.equal(notifications.at(-1).content.text, "Mock received: hello");
  } finally {
    if (previousProvider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.UNREAL_HARNESS_LLM_MODEL;
    else process.env.UNREAL_HARNESS_LLM_MODEL = previousModel;
  }
});

test("steers an active task after allowing the current tool to finish", async () => {
  const provider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  const workspace = await mkdtemp(path.join(tmpdir(), "unreal-agent-steering-workspace-"));
  try {
    const bridge = new UnrealAgentBridge({
      dataDir: await mkdtemp(path.join(tmpdir(), "unreal-agent-steering-data-")),
      runner: path.join(here, "fixtures", "steering-runner.mjs")
    });
    bridge.capabilityBroker = { server: {}, start: async () => {}, warm: () => {}, closeSession: () => {} };
    const { sessionId } = await bridge.newSession({ cwd: workspace });
    const session = bridge.sessions.get(sessionId);
    session.permissionMode = "danger-full-access";
    session.fullAccessApproved = true;
    const updates = [];
    const client = { notify: async (_method, params) => updates.push(params.update) };
    const run = (text) => bridge.prompt({ sessionId, prompt: [{ type: "text", text }] }, client);

    const first = run("first task");
    const orderFile = path.join(workspace, "prompt-order.txt");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await access(orderFile).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await access(orderFile).then(() => true, () => false), true);
    const toolActive = path.join(workspace, "tool-active.txt");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await access(toolActive).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await access(toolActive).then(() => true, () => false), true);
    assert.equal(session.child?.exitCode, null);

    const steered = run("change direction: keep the existing implementation and add a regression test");
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(session.child?.exitCode, null, "let an already-running tool reach its safe boundary");
    assert.equal(await access(path.join(workspace, "interrupted.txt")).then(() => true, () => false), false);
    await writeFile(path.join(workspace, "release-tool.txt"), "done");
    assert.deepEqual(await first, { stopReason: "end_turn" });
    assert.deepEqual(await steered, { stopReason: "end_turn" });
    assert.deepEqual((await readFile(orderFile, "utf8")).trim().split("\n"), [
      "first task", "change direction: keep the existing implementation and add a regression test"
    ]);
    const requests = (await readFile(path.join(workspace, "requests.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(requests[0].session_id, requests[1].session_id);
    assert.deepEqual(requests[1].messages, [{
      role: "user", content: "change direction: keep the existing implementation and add a regression test"
    }]);
    assert.match(await readFile(path.join(workspace, "interrupted.txt"), "utf8"), /resumed after tool boundary/);
    assert.match(updates.find((item) => item.sessionUpdate === "agent_message_chunk").content.text,
      /Resumed with steering: change direction: keep the existing implementation and add a regression test/);
    assert.equal(session.child, null);
    assert.equal(session.activeTurn, null);
  } finally {
    if (provider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = provider;
  }
});

test("supports Hydra's dedicated model-change request and persists it", async () => {
  const previousProvider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  const previousModel = process.env.UNREAL_HARNESS_LLM_MODEL;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  process.env.UNREAL_HARNESS_LLM_MODEL = "gpt-6-astra";
  try {
    const dataDir = await mkdtemp(path.join(tmpdir(), "unreal-agent-acp-set-model-"));
    const bridge = new UnrealAgentBridge({ dataDir });
    const created = await bridge.newSession({ cwd: here, mcpServers: [] });

    assert.deepEqual(await bridge.setModel({
      sessionId: created.sessionId, modelId: "gpt-5.6-luna"
    }), {});
    assert.equal(bridge.sessions.get(created.sessionId).model, "gpt-5.6-luna");

    const restarted = new UnrealAgentBridge({ dataDir });
    const resumed = await restarted.resumeSession({ sessionId: created.sessionId, cwd: here });
    assert.equal(resumed.configOptions.find((option) => option.id === "model").currentValue, "gpt-5.6-luna");
    await assert.rejects(bridge.setModel({
      sessionId: created.sessionId, modelId: "not-a-real-model"
    }), /Unsupported model selection/);
  } finally {
    if (previousProvider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.UNREAL_HARNESS_LLM_MODEL;
    else process.env.UNREAL_HARNESS_LLM_MODEL = previousModel;
  }
});

test("registers session/set_model on the ACP transport used by Hydra", async () => {
  const previousProvider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  const previousModel = process.env.UNREAL_HARNESS_LLM_MODEL;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  process.env.UNREAL_HARNESS_LLM_MODEL = "gpt-6-astra";
  const bridge = new UnrealAgentBridge({
    dataDir: await mkdtemp(path.join(tmpdir(), "unreal-agent-acp-model-transport-"))
  });
  const client = acp.client({ name: "model-picker-test" });
  const connection = client.connect(createAgentApp(bridge));
  try {
    const created = await connection.agent.request("session/new", { cwd: here, mcpServers: [] });
    assert.deepEqual(await connection.agent.request("session/set_model", {
      sessionId: created.sessionId, modelId: "gpt-5.6-terra"
    }), {});
    assert.equal(bridge.sessions.get(created.sessionId).model, "gpt-5.6-terra");
  } finally {
    connection.close();
    await connection.closed;
    if (previousProvider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.UNREAL_HARNESS_LLM_MODEL;
    else process.env.UNREAL_HARNESS_LLM_MODEL = previousModel;
  }
});

test("reports deduplicated token and billed cost totals in ACP and the usage selector across resume", async () => {
  const provider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  try {
    const dataDir = await mkdtemp(path.join(tmpdir(), "unreal-agent-acp-usage-"));
    const makeBridge = () => {
      const bridge = new UnrealAgentBridge({ dataDir, runner: path.join(here, "fixtures", "usage-runner.mjs") });
      bridge.capabilityBroker = { server: {}, start: async () => {}, warm: () => {}, closeSession: () => {} };
      return bridge;
    };
    const bridge = makeBridge();
    const created = await bridge.newSession({ cwd: here });
    const usage = (options) => options.find((option) => option.id === "usage");
    assert.match(usage(created.configOptions).options[0].name, /^Cost Unavailable · Input 0 \(0% cached\)/);
    bridge.sessions.get(created.sessionId).permissionMode = "danger-full-access";
    bridge.sessions.get(created.sessionId).fullAccessApproved = true;
    const notifications = [];
    const run = (agent) => agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] }, {
      notify: async (_method, params) => notifications.push(params.update)
    });
    const result = await run(bridge);
    assert.deepEqual(result.usage, {
      totalTokens: 350, inputTokens: 300, outputTokens: 50,
      cachedReadTokens: 190, cachedWriteTokens: 10, thoughtTokens: 8
    });
    const reports = notifications.filter((item) => item.sessionUpdate === "usage_update");
    assert.equal(reports.length, 2);
    assert.equal(reports.at(-1).cost.currency, "USD");
    assert.ok(Math.abs(reports.at(-1).cost.amount - 0.00323) < 1e-12);
    assert.deepEqual(reports.at(-1)._meta["unreal-agent/usage"], {
      inputTokens: 300, outputTokens: 50, cachedReadTokens: 190, cachedWriteTokens: 10
    });
    assert.equal(reports.at(-1).used, 0); // Unknown context size is not fabricated.
    const updated = notifications.filter((item) => item.sessionUpdate === "config_option_update").at(-1);
    assert.match(usage(updated.configOptions).options[0].name, /^Cost \$0\.00 · Input 300 \(63% cached\).*Output 50/);
    assert.match(usage(updated.configOptions).options[2].name, /190 \(63% of input\).*10/);
    await assert.rejects(bridge.setConfigOption({ sessionId: created.sessionId, configId: "usage", value: "fake" }), /Unsupported usage/);
    const resumed = makeBridge();
    const state = await resumed.resumeSession({ sessionId: created.sessionId, cwd: here });
    assert.match(usage(state.configOptions).options[0].name, /^Cost \$0\.00 · Input 300 \(63% cached\)/);
    resumed.sessions.get(created.sessionId).permissionMode = "danger-full-access";
    const replay = await run(resumed);
    assert.equal(replay.usage, undefined);
    assert.equal(notifications.filter((item) => item.sessionUpdate === "usage_update").length, 2);
  } finally {
    if (provider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = provider;
  }
});

test("does not invent a cost when a model response lacks billing data", async () => {
  const provider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  try {
    const bridge = new UnrealAgentBridge({
      dataDir: await mkdtemp(path.join(tmpdir(), "unreal-agent-acp-no-cost-")),
      runner: path.join(here, "fixtures", "usage-runner.mjs")
    });
    bridge.capabilityBroker = { server: {}, start: async () => {}, warm: () => {}, closeSession: () => {} };
    const { sessionId } = await bridge.newSession({ cwd: here });
    bridge.sessions.get(sessionId).permissionMode = "danger-full-access";
    bridge.sessions.get(sessionId).fullAccessApproved = true;
    const updates = [];
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "unknown" }] }, {
      notify: async (_method, params) => updates.push(params.update)
    });
    const costs = updates.filter((update) => update.sessionUpdate === "usage_update").map((update) => update.cost);
    assert.equal(costs.length, 2);
    assert.equal(costs[0].amount, 0.00123);
    assert.equal(costs[1], null);
    const config = updates.filter((update) => update.sessionUpdate === "config_option_update").at(-1);
    assert.match(config.configOptions.find((option) => option.id === "usage").options[0].name, /Cost Unavailable/);
  } finally {
    if (provider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = provider;
  }
});

test("abbreviates displayed token counts without changing ACP usage totals", () => {
  for (const [tokens, label] of [
    [0, "0"], [999, "999"], [1_000, "1k"], [1_234, "1.23k"],
    [12_345, "12.3k"], [131_000, "131k"], [999_999, "1m"],
    [1_000_000, "1m"], [1_250_000, "1.25m"], [12_345_678, "12.3m"]
  ]) assert.equal(formatTokenCount(tokens), label);
});

test("rounds displayed usage costs to cents without changing reported costs", () => {
  for (const [amount, label] of [
    [0, "$0.00"], [0.00323, "$0.00"], [0.005, "$0.01"],
    [1.234, "$1.23"], [1.235, "$1.24"]
  ]) assert.equal(formatUsageCost(amount), label);
  assert.equal(formatUsageCost(Number.NaN), "Unavailable");
});

test("reports edits from failed turns and always clears the active client", async () => {
  const provider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  const workspace = await mkdtemp(path.join(tmpdir(), "unreal-agent-failed-turn-"));
  try {
    const bridge = new UnrealAgentBridge({
      dataDir: await mkdtemp(path.join(tmpdir(), "unreal-agent-failed-data-")),
      runner: path.join(here, "fixtures", "failing-runner.mjs")
    });
    bridge.capabilityBroker = { server: {}, start: async () => {}, warm: () => {}, closeSession: () => {} };
    const { sessionId } = await bridge.newSession({ cwd: workspace });
    const session = bridge.sessions.get(sessionId);
    session.permissionMode = "danger-full-access";
    session.fullAccessApproved = true;
    const updates = [];
    await assert.rejects(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "edit then fail" }] }, {
      notify: async (_method, params) => updates.push(params.update)
    }), /intentional runner failure/);
    const diff = updates.find((update) => update.kind === "edit");
    assert.equal(diff.content[0].newText, "kept after failure\n");
    assert.equal(session.activeClient, null);
    assert.equal(session.child, null);

    bridge.runner = path.join(workspace, "missing-runner");
    await assert.rejects(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "setup failure" }] }, {
      notify: async () => {}
    }), /ENOENT|spawn/);
    assert.equal(session.activeClient, null);
  } finally {
    if (provider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = provider;
  }
});

test("reports edits from cancelled turns", async () => {
  const provider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  const workspace = await mkdtemp(path.join(tmpdir(), "unreal-agent-cancelled-turn-"));
  try {
    const bridge = new UnrealAgentBridge({
      dataDir: await mkdtemp(path.join(tmpdir(), "unreal-agent-cancelled-data-")),
      runner: path.join(here, "fixtures", "cancelled-runner.mjs")
    });
    bridge.capabilityBroker = { server: {}, start: async () => {}, warm: () => {}, closeSession: () => {} };
    const { sessionId } = await bridge.newSession({ cwd: workspace });
    const session = bridge.sessions.get(sessionId);
    session.permissionMode = "danger-full-access";
    session.fullAccessApproved = true;
    const updates = [];
    const turn = bridge.prompt({ sessionId, prompt: [{ type: "text", text: "edit then wait" }] }, {
      notify: async (_method, params) => updates.push(params.update)
    });
    const editedFile = path.join(workspace, "cancelled-turn-edit.txt");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await access(editedFile).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await bridge.cancel({ sessionId });
    assert.equal((await turn).stopReason, "cancelled");
    const diff = updates.find((update) => update.kind === "edit");
    assert.equal(diff.content[0].newText, "kept after cancellation\n");
  } finally {
    if (provider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = provider;
  }
});
