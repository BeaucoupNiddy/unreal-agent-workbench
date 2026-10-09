import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { UnrealAgentBridge } from "../src/bridge.mjs";
import { saveLocalProvider } from "../src/local-providers.mjs";

test("a local default discovers its models, sends the local connection to the runner, and keeps its endpoint on resume", async () => {
  const envKeys = ["UNREAL_HARNESS_LLM_PROVIDER", "UNREAL_HARNESS_LLM_MODEL", "UNREAL_HARNESS_LLM_BASE_URL", "UNREAL_HARNESS_LLM_API_KEY"];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  const dataDir = await mkdtemp(path.join(tmpdir(), "local-bridge-data-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "local-bridge-workspace-"));
  const runner = fileURLToPath(new URL("./fixtures/local-model-runner.mjs", import.meta.url));
  await chmod(runner, 0o755);
  const bridge = new UnrealAgentBridge({ dataDir, runner, codexCatalog: { load: async () => ({ models: [], source: "fallback", fetchedAt: 0 }) }, fetch: async (url) => ({ ok: true, json: async () =>
    url.includes("openrouter") ? { data: [{ id: "vendor/cloud" }] } : { data: [{ id: "local-alpha" }, { id: "local-beta" }] } }) });
  bridge.capabilityBroker = { server: {}, start: async () => {}, warm: () => {}, closeSession: () => {}, close: async () => {} };
  try {
    const connection = await saveLocalProvider(dataDir, { type: "omlx", name: "My oMLX", baseUrl: "http://localhost:8000/v1", apiKey: "unit-test-secret" });
    await writeFile(path.join(dataDir, "default-model.json"), JSON.stringify({ provider: connection.id, model: "local-beta" }));
    const catalog = await bridge.providerCatalog();
    assert.equal(catalog.providers.length, 4);
    assert.equal(catalog.providers.at(-1).apiKey, undefined);
    const { sessionId } = await bridge.newSession({ cwd: workspace, _meta: { "unreal-agent": { projectHistory: false } } });
    const session = bridge.sessions.get(sessionId);
    assert.equal(session.provider, connection.id);
    assert.equal(session.model, "local-beta");
    assert.equal(session.localConnection.baseUrl, "http://localhost:8000/v1");
    session.permissionMode = "danger-full-access"; session.fullAccessApproved = true;
    const updates = [];
    await bridge.prompt({ sessionId, prompt: [{ type: "text", text: "Hello" }] }, { notify: async (_, params) => updates.push(params.update) });
    const output = JSON.parse(updates.find((update) => update.sessionUpdate === "agent_message_chunk").content.text);
    assert.deepEqual(output, { provider: "openai", model: "local-beta", baseUrl: "http://localhost:8000/v1", keyMatches: true });
    assert.equal((await readFile(bridge.sessionMetadataPath(sessionId), "utf8")).includes("unit-test-secret"), false);
    await bridge.closeSession({ sessionId });
    await saveLocalProvider(dataDir, { ...connection, baseUrl: "http://localhost:9000/v1", apiKey: "new-key" });
    await bridge.resumeSession({ sessionId, cwd: workspace });
    assert.equal(bridge.sessions.get(sessionId).localConnection.baseUrl, "http://localhost:8000/v1");
    await assert.rejects(bridge.prompt({ sessionId, prompt: [{ type: "text", text: "Hello" }] }, { notify: async () => {} }), /address has changed/);
    assert.equal(bridge.sessions.get(sessionId).model, "local-beta");
    const next = await bridge.newSession({ cwd: workspace });
    assert.equal(bridge.sessions.get(next.sessionId).localConnection.baseUrl, "http://localhost:9000/v1");
  } finally {
    await bridge.close();
    for (const key of envKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
