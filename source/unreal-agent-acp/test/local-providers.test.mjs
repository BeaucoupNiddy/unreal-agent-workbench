import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeLocalBaseUrl, normalizeLocalProvider, readLocalProviders, saveLocalProvider,
  discoverLocalModels, localProviderCatalog, localRunnerEnvironment } from "../src/local-providers.mjs";
import { normalizeModelSettings, resolveProviderSettings } from "../src/model-settings.mjs";

const connection = (extra = {}) => ({ type: "omlx", name: "My oMLX", baseUrl: "http://127.0.0.1:8000/v1", ...extra });
const directory = () => mkdtemp(path.join(tmpdir(), "local-providers-test-"));

test("normalizes server addresses and rejects credential-bearing or non-HTTP URLs", () => {
  assert.equal(normalizeLocalBaseUrl(" http://localhost:8000/ "), "http://localhost:8000/v1");
  assert.equal(normalizeLocalBaseUrl("http://localhost:8000/v1/"), "http://localhost:8000/v1");
  for (const url of ["file:///tmp/models", "http://key@localhost:8000/v1", "http://localhost:8000/v1?key=secret", "not a URL"]) {
    assert.throws(() => normalizeLocalBaseUrl(url), /server address|HTTP/);
  }
});

test("saves multiple local connections, keeps keys out of responses, and preserves or clears a saved key", async () => {
  const dataDir = await directory();
  const [first, second] = await Promise.all([
    saveLocalProvider(dataDir, connection({ apiKey: "unit-test-secret" })),
    saveLocalProvider(dataDir, connection({ type: "ollama", name: "Ollama", baseUrl: "http://localhost:11434" }))
  ]);
  assert.notEqual(first.id, second.id);
  assert.equal(first.hasApiKey, true);
  assert.equal(JSON.stringify(first).includes("unit-test-secret"), false);
  assert.equal((await readLocalProviders(dataDir)).length, 2);
  await saveLocalProvider(dataDir, { ...first, name: "Renamed", manualModels: ["qwen3:8b", "qwen3:8b"] });
  assert.equal((await readLocalProviders(dataDir))[0].apiKey, "unit-test-secret");
  assert.equal((await readLocalProviders(dataDir))[0].manualModels.length, 1);
  await saveLocalProvider(dataDir, { ...first, apiKey: "" });
  assert.equal((await readLocalProviders(dataDir))[0].apiKey, "");
  assert.equal((await stat(path.join(dataDir, "local-providers.json"))).mode & 0o777, 0o600);
  await assert.rejects(saveLocalProvider(dataDir, connection({ id: "local-missing" })), /no longer exists/);
});

test("discovers models using only the connection's optional key, filters embedding models, and rejects bad catalogs", async () => {
  const config = normalizeLocalProvider(connection({ apiKey: "unit-test-secret" }));
  const models = await discoverLocalModels(config, { fetch: async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8000/v1/models");
    assert.equal(options.headers.Authorization, "Bearer unit-test-secret");
    return { ok: true, json: async () => ({ data: [{ id: "local-coder" }, { id: "local-coder" }, { id: "embed", type: "embedding" }] }) };
  } });
  assert.deepEqual(models.map((model) => model.value), ["local-coder"]);
  await assert.rejects(discoverLocalModels(config, { fetch: async () => ({ status: 401 }) }), /valid server API key/);
  await assert.rejects(discoverLocalModels(config, { fetch: async () => ({ ok: true, json: async () => ({ wrong: [] }) }) }), /invalid model list/);
  await assert.rejects(discoverLocalModels(config, { fetch: async () => { throw new Error("connection refused"); } }), /Cannot reach My oMLX/);
});

test("keeps discovered and manual models when a local server goes offline, and reports a failed manual refresh", async () => {
  const dataDir = await directory();
  const saved = await saveLocalProvider(dataDir, connection({ manualModels: ["manual-coder"] }));
  let config = (await readLocalProviders(dataDir))[0];
  const initial = await localProviderCatalog(dataDir, config, { fetch: async () => ({ ok: true,
    json: async () => ({ data: [{ id: "discovered-coder" }] }) }) });
  assert.deepEqual(initial.models.map((model) => model.value), ["discovered-coder", "manual-coder"]);
  assert.equal(initial.status, "connected");
  assert.equal(initial.apiKey, undefined);
  config = (await readLocalProviders(dataDir))[0];
  const offline = async () => { throw new Error("offline"); };
  const cached = await localProviderCatalog(dataDir, { ...config, fetchedAt: 1 }, { fetch: offline });
  assert.equal(cached.status, "offline");
  assert.equal(cached.models.length, 2);
  await assert.rejects(localProviderCatalog(dataDir, config, { force: true, fetch: offline }), /Cannot reach/);
  assert.equal((await readLocalProviders(dataDir))[0].cachedModels.length, 1);
  await saveLocalProvider(dataDir, { ...saved, baseUrl: "http://localhost:9000/v1" });
  assert.equal((await readLocalProviders(dataDir))[0].cachedModels, undefined);
  assert.equal((await readFile(path.join(dataDir, "local-providers.json"), "utf8")).includes("discovered-coder"), false);
});

test("local defaults never fall back to a cloud model and use the runner's compatible API adapter", () => {
  const settings = normalizeModelSettings({ provider: "local-example", model: "qwen3:8b" });
  assert.equal(settings.provider, "local-example");
  assert.deepEqual(resolveProviderSettings({ provider: "openai-codex", model: "gpt-6-astra" }, settings, {}), { provider: "local-example", model: "" });
  assert.deepEqual(localRunnerEnvironment(connection(), "", {}), {
    UNREAL_HARNESS_LLM_PROVIDER: "openai", UNREAL_HARNESS_LLM_BASE_URL: "http://127.0.0.1:8000/v1", UNREAL_HARNESS_LLM_API_KEY: "local-model"
  });
  assert.equal(localRunnerEnvironment(connection(), "saved-key", { UNREAL_HARNESS_LLM_API_KEY: "explicit-key" }).UNREAL_HARNESS_LLM_API_KEY, "explicit-key");
});
