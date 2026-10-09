import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnrealAgentBridge } from "../src/bridge.mjs";

test("new chats retain model and effort across bridge restarts, but not permission grants", async () => {
  const previousProvider = process.env.UNREAL_HARNESS_LLM_PROVIDER;
  const previousModel = process.env.UNREAL_HARNESS_LLM_MODEL;
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  delete process.env.UNREAL_HARNESS_LLM_MODEL;
  try {
  const dataDir = await mkdtemp(path.join(tmpdir(), "chat-preferences-"));
  const options = { dataDir, codexCatalog: { load: async () => ({ models: [], source: "fallback", fetchedAt: 0 }) } };
  const bridge = new UnrealAgentBridge(options);
  const first = await bridge.newSession({ cwd: dataDir });
  await bridge.setConfigOption({ sessionId: first.sessionId, configId: "model", value: "gpt-6-luna" });
  await bridge.setConfigOption({ sessionId: first.sessionId, configId: "thought_level", value: "xhigh" });
  await bridge.setConfigOption({ sessionId: first.sessionId, configId: "permission_mode", value: "danger-full-access" });
  const saved = JSON.parse(await readFile(path.join(dataDir, "default-model.json"), "utf8"));
  assert.equal(saved.model, "gpt-6-luna");
  assert.equal(saved.thoughtLevel, "xhigh");
  assert.equal(saved.permissionMode, undefined);
  const restarted = new UnrealAgentBridge(options);
  const second = await restarted.newSession({ cwd: dataDir });
  const value = id => second.configOptions.find(option => option.id === id).currentValue;
  assert.equal(value("model"), "gpt-6-luna");
  assert.equal(value("thought_level"), "xhigh");
  assert.equal(value("permission_mode"), "workspace-write");
  } finally {
    if (previousProvider === undefined) delete process.env.UNREAL_HARNESS_LLM_PROVIDER;
    else process.env.UNREAL_HARNESS_LLM_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.UNREAL_HARNESS_LLM_MODEL;
    else process.env.UNREAL_HARNESS_LLM_MODEL = previousModel;
  }
});
