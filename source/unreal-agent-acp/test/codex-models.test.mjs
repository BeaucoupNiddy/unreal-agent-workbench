import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexModelCatalog, codexHome, parseCodexModelCatalog } from "../src/codex-models.mjs";
import { UnrealAgentBridge } from "../src/bridge.mjs";

const model = (slug) => ({ slug, display_name: slug === "gpt-6.1-sol" ? "GPT-6.1 Sol" : slug,
  visibility: "list", description: "A coding model", model_messages: { secret: "runtime instructions" } });
const payload = (ids) => ({ models: ids.map(model) });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-models-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "codex-home"), dataDir = path.join(root, "bridge");
  await mkdir(home);
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ tokens: {
    access_token: "test-token-never-cache", account_id: "test-account" } }));
  let time = Date.parse("2026-01-01T12:00:00Z"), requests = 0, ids = ["gpt-6-astra"], failure;
  const catalog = new CodexModelCatalog({ home, dataDir, now: () => time, fetch: async (url, options) => {
    requests++;
    assert.match(url, /^https:\/\/chatgpt.com\/backend-api\/codex\/models\?client_version=/);
    assert.equal(options.headers.Authorization, "Bearer test-token-never-cache");
    assert.equal(options.headers["ChatGPT-Account-Id"], "test-account");
    assert.ok(options.signal);
    if (failure) throw new Error(failure);
    return { ok: true, json: async () => payload(ids) };
  } });
  return { root, home, dataDir, catalog, requests: () => requests,
    setIds: (value) => { ids = value; }, setFailure: (value) => { failure = value; },
    advance: (ms) => { time += ms; }, time: () => time };
}

test("normalizes arbitrary future Codex models, excludes hidden IDs and runtime instructions", () => {
  const models = parseCodexModelCatalog({ models: [model("gpt-future"), model("gpt-6.1-sol"),
    { ...model("hidden"), visibility: "hide" }, { ...model("hidden2"), hidden: true },
    null, { slug: "" }, { slug: "bad\nmodel" }, model("gpt-future")] });
  assert.deepEqual(models.map((x) => x.value), ["gpt-future", "gpt-6.1-sol"]);
  assert.equal(models[1].name, "GPT-6.1 Sol");
  assert.equal(JSON.stringify(models).includes("runtime instructions"), false);
  assert.throws(() => parseCodexModelCatalog({ data: [] }), /invalid/);
  assert.equal(codexHome({ CODEX_HOME: "/custom/codex" }), "/custom/codex");
});

test("automatically discovers a newly released model after five minutes and writes only private picker metadata", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.catalog.load()).source, "catalog");
  f.setIds(["gpt-6-astra", "gpt-future-not-bundled"]);
  assert.equal((await f.catalog.load()).models.length, 1);
  assert.equal(f.requests(), 1);
  f.advance(5 * 60 * 1000);
  assert.equal((await f.catalog.load()).models[1].value, "gpt-future-not-bundled");
  assert.equal(f.requests(), 2);
  const cache = await readFile(f.catalog.cachePath, "utf8");
  assert.equal(cache.includes("test-token"), false);
  assert.equal(cache.includes("test-account"), false);
  assert.equal(cache.includes("runtime instructions"), false);
  assert.equal((await stat(f.catalog.cachePath)).mode & 0o777, 0o600);
});

test("manual refresh bypasses fresh cache, shares concurrent requests, and failures preserve it", async (t) => {
  const f = await fixture(t);
  await Promise.all([f.catalog.load(), f.catalog.load()]);
  assert.equal(f.requests(), 1);
  f.setIds(["gpt-6-astra", "gpt-6.1-sol"]);
  await Promise.all([f.catalog.load({ force: true }), f.catalog.load({ force: true })]);
  assert.equal(f.requests(), 2);
  const before = await readFile(f.catalog.cachePath, "utf8");
  f.setFailure("Offline");
  await assert.rejects(f.catalog.load({ force: true }), /Could not refresh.*Offline/);
  assert.equal(await readFile(f.catalog.cachePath, "utf8"), before);
  f.advance(5 * 60 * 1000);
  assert.equal((await f.catalog.load()).models.length, 2);
  const requests = f.requests();
  await f.catalog.load();
  assert.equal(f.requests(), requests, "offline retries are throttled");
});

test("reads fresh native Codex cache on every load and adopts updates without network", async (t) => {
  const f = await fixture(t);
  const native = path.join(f.home, "models_cache.json");
  await writeFile(native, JSON.stringify({ ...payload(["gpt-native"]), fetched_at: new Date(f.time()).toISOString(), client_version: "0.159.0" }));
  assert.equal((await f.catalog.load()).models[0].value, "gpt-native");
  assert.equal(f.requests(), 0);
  await writeFile(native, JSON.stringify({ ...payload(["gpt-native", "gpt-6.1-sol"]), fetched_at: new Date(f.time()).toISOString() }));
  assert.equal((await f.catalog.load()).models.length, 2);
  assert.equal(f.requests(), 0);
  await rm(path.join(f.home, "auth.json"));
  f.advance(5 * 60 * 1000);
  assert.equal((await f.catalog.load()).models.length, 2);
  await assert.rejects(f.catalog.load({ force: true }), /Sign in with Codex/);
});

test("cached-only loads reuse the shared catalog across bridge processes", async (t) => {
  const f = await fixture(t);
  await f.catalog.load();
  f.advance(10 * 60 * 1000);
  const other = new CodexModelCatalog({ dataDir: f.dataDir, home: f.home, now: f.time, fetch: async () => { throw new Error("No download expected"); } });
  assert.equal((await other.load({ cachedOnly: true })).models[0].value, "gpt-6-astra");
});

test("empty, malformed, and HTTP-error catalogs never replace the last successful list", async (t) => {
  const f = await fixture(t);
  await f.catalog.load();
  const before = await readFile(f.catalog.cachePath, "utf8");
  for (const response of [{ ok: false, status: 401 }, { ok: true, json: async () => ({ models: [] }) },
    { ok: true, json: async () => ({ unknown: [] }) }]) {
    f.catalog.fetch = async () => response;
    await assert.rejects(f.catalog.load({ force: true }), /Could not refresh/);
    assert.equal(await readFile(f.catalog.cachePath, "utf8"), before);
  }
});

test("Settings, new/resumed sessions, and live chat refresh all expose new Codex IDs without hard-coding", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "workspace.txt"), "workspace");
  await mkdir(f.dataDir);
  await writeFile(path.join(f.dataDir, "default-model.json"), JSON.stringify({ provider: "openai-codex", model: "gpt-6-astra" }));
  const oldEnv = { provider: process.env.UNREAL_HARNESS_LLM_PROVIDER, model: process.env.UNREAL_HARNESS_LLM_MODEL };
  process.env.UNREAL_HARNESS_LLM_PROVIDER = "openai-codex";
  delete process.env.UNREAL_HARNESS_LLM_MODEL;
  t.after(() => {
    for (const [key, value] of [["UNREAL_HARNESS_LLM_PROVIDER", oldEnv.provider], ["UNREAL_HARNESS_LLM_MODEL", oldEnv.model]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const bridge = new UnrealAgentBridge({ dataDir: f.dataDir, codexCatalog: f.catalog,
    fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: "vendor/test" }] }) }) });
  const first = await bridge.newSession({ cwd: f.root });
  const second = await bridge.newSession({ cwd: f.root });
  await bridge.setConfigOption({ sessionId: first.sessionId, configId: "favorite_model", value: "gpt-6-astra" });
  f.setIds(["gpt-6-astra", "gpt-6.1-sol", "gpt-future-not-bundled"]);
  const settings = await bridge.providerCatalog({ refreshProvider: "openai-codex" });
  const codex = settings.providers.find((p) => p.id === "openai-codex");
  assert.equal(codex.source, "catalog");
  assert.ok(codex.updatedAt);
  assert.ok(codex.models.some((m) => m.value === "gpt-future-not-bundled"));
  for (const id of [first.sessionId, second.sessionId]) {
    const result = await bridge.setConfigOption({ sessionId: id, configId: "refresh_models", value: "cached" });
    const option = result.configOptions.find((x) => x.id === "model");
    assert.equal(option.currentValue, "gpt-6-astra");
    assert.equal(option.options[0].favorite, true);
    assert.ok(option.options.some((m) => m.value === "gpt-future-not-bundled"));
  }
  await bridge.setModel({ sessionId: first.sessionId, modelId: "gpt-future-not-bundled" });
  bridge.sessions.delete(first.sessionId);
  const resumed = await bridge.resumeSession({ sessionId: first.sessionId, cwd: f.root });
  assert.equal(resumed.configOptions.find((x) => x.id === "model").currentValue, "gpt-future-not-bundled");
  f.advance(5 * 60 * 1000);
  f.setIds(["gpt-6-astra", "gpt-future-2"]);
  const auto = await bridge.setConfigOption({ sessionId: first.sessionId, configId: "refresh_models", value: "auto" });
  const option = auto.configOptions.find((x) => x.id === "model");
  assert.equal(option.currentValue, "gpt-future-not-bundled", "removed current IDs remain selectable");
  assert.ok(option.options.some((m) => m.value === "gpt-future-2"));
});

test("manual refresh queued behind a cached load still contacts Codex", async (t) => {
  const f = await fixture(t);
  await f.catalog.load();
  f.setIds(["gpt-future-after-cached-read"]);
  const cached = f.catalog.load({ cachedOnly: true });
  const forced = f.catalog.load({ force: true });
  assert.equal((await cached).models[0].value, "gpt-6-astra");
  assert.equal((await forced).models[0].value, "gpt-future-after-cached-read");
  assert.equal(f.requests(), 2);
});
