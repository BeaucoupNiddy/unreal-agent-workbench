import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const localProviderPresets = [
  { id: "omlx", name: "oMLX", baseUrl: "http://127.0.0.1:8000/v1" },
  { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "llamacpp", name: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
  { id: "vllm", name: "vLLM", baseUrl: "http://127.0.0.1:8000/v1" },
  { id: "custom", name: "Other compatible server", baseUrl: "http://127.0.0.1:8000/v1" }
];
export const isLocalProvider = (id) => /^local-[A-Za-z0-9_-]{1,80}$/.test(id || "");
const updateQueues = new Map();
const settingsPath = (dataDir) => path.join(dataDir, "local-providers.json");

export function normalizeLocalBaseUrl(value) {
  let url;
  try { url = new URL(typeof value === "string" ? value.trim() : ""); }
  catch { throw new Error("Enter the server's HTTP or HTTPS address."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP or HTTPS server address without credentials or query parameters.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/v1";
  return url.href.replace(/\/+$/, "");
}

export function normalizeLocalModels(values = []) {
  if (!Array.isArray(values) || values.length > 1000) throw new Error("Enter up to 1,000 model IDs.");
  return [...new Map(values.map((value) => {
    const id = typeof value === "string" ? value.trim() : value?.value?.trim();
    if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id)) throw new Error("Enter a valid local model ID.");
    const name = typeof value?.name === "string" ? value.name.trim().slice(0, 200) : id;
    return [id, { value: id, name: name || id, ...(value?.description ? { description: String(value.description).slice(0, 500) } : {}) }];
  })).values()];
}

export function normalizeLocalProvider(input, previous = {}) {
  const preset = localProviderPresets.find((item) => item.id === input?.type);
  if (!preset) throw new Error("Choose a local model tool.");
  const name = typeof input.name === "string" ? input.name.trim() : preset.name;
  if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new Error("Enter a connection name between 1 and 80 characters.");
  const apiKey = input.apiKey === undefined ? previous.apiKey || "" : input.apiKey;
  if (typeof apiKey !== "string" || apiKey.length > 4000 || /[\u0000-\u001f]/.test(apiKey)) throw new Error("Enter a valid server API key.");
  return {
    id: previous.id || `local-${randomUUID()}`, type: preset.id, name,
    baseUrl: normalizeLocalBaseUrl(input.baseUrl || preset.baseUrl), apiKey: apiKey.trim(),
    manualModels: normalizeLocalModels(input.manualModels || [])
  };
}

export async function readLocalProviders(dataDir) {
  try {
    const values = JSON.parse(await fs.readFile(settingsPath(dataDir), "utf8"));
    if (!Array.isArray(values)) throw new Error("Local connections could not be read.");
    return values.map((value) => {
      if (!isLocalProvider(value?.id)) throw new Error("Local connections could not be read.");
      return { ...value, ...normalizeLocalProvider(value, value) };
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function updateLocalProviders(dataDir, change) {
  const target = settingsPath(dataDir);
  const pending = (updateQueues.get(target) || Promise.resolve()).then(async () => {
    const values = await readLocalProviders(dataDir);
    const result = await change(values);
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
    return result;
  });
  updateQueues.set(target, pending.catch(() => {}));
  return pending;
}

export function publicLocalProvider(connection) {
  const { apiKey, cachedModels, fetchedAt, ...settings } = connection;
  return { ...settings, hasApiKey: Boolean(apiKey), local: true };
}

export async function saveLocalProvider(dataDir, input) {
  return updateLocalProviders(dataDir, (values) => {
    const previous = input.id ? values.find((item) => item.id === input.id) : null;
    if (input.id && !previous) throw new Error("This local connection no longer exists.");
    if (!previous && values.length >= 30) throw new Error("You can add up to 30 local connections.");
    const connection = normalizeLocalProvider(input, previous || {});
    if (previous) {
      if (connection.baseUrl === previous.baseUrl && connection.apiKey === previous.apiKey) {
        connection.cachedModels = previous.cachedModels;
        connection.fetchedAt = previous.fetchedAt;
      }
      values[values.indexOf(previous)] = connection;
    } else values.push(connection);
    return publicLocalProvider(connection);
  });
}

export async function discoverLocalModels(connection, { fetch = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetch(`${connection.baseUrl}/models`, {
      headers: { Accept: "application/json", ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) },
      signal: AbortSignal.timeout(3000), redirect: "error"
    });
  } catch { throw new Error(`Cannot reach ${connection.name}. Start its server and check the address.`); }
  if (response.status === 401 || response.status === 403) throw new Error(`${connection.name} requires a valid server API key.`);
  if (!response.ok) throw new Error(`${connection.name} could not list models (HTTP ${response.status}). You can add model IDs manually.`);
  let data;
  try { data = (await response.json()).data; }
  catch { throw new Error(`${connection.name} returned an invalid model list.`); }
  if (!Array.isArray(data)) throw new Error(`${connection.name} returned an invalid model list.`);
  return normalizeLocalModels(data.filter((model) => typeof model?.id === "string"
    && !["embedding", "embeddings", "reranker", "reranking"].includes(model.type || model.model_type)
  ).map((model) => ({ value: model.id, name: model.name || model.id, description: "Runs on your model server" })));
}

export async function localProviderCatalog(dataDir, connection, { fetch = globalThis.fetch, force = false } = {}) {
  let models = connection.cachedModels || [], updatedAt = connection.fetchedAt || null, error = null;
  if (force || !updatedAt || Date.now() - updatedAt > 30_000) {
    try {
      models = await discoverLocalModels(connection, { fetch });
      updatedAt = Date.now();
      await updateLocalProviders(dataDir, (values) => {
        const current = values.find((item) => item.id === connection.id);
        if (current?.baseUrl === connection.baseUrl && current?.apiKey === connection.apiKey) {
          current.cachedModels = models; current.fetchedAt = updatedAt;
        }
      });
    } catch (caught) {
      if (force) throw caught;
      error = caught.message;
    }
  }
  models = [...new Map([...models, ...connection.manualModels].map((model) => [model.value, model])).values()];
  return { ...publicLocalProvider(connection), description: `${connection.name} · ${connection.baseUrl}`,
    models, defaultModel: models[0]?.value || "", source: "local", status: error ? "offline" : "connected", error, updatedAt };
}

export function localRunnerEnvironment(connection, apiKey, env = process.env) {
  return {
    UNREAL_HARNESS_LLM_PROVIDER: "openai",
    UNREAL_HARNESS_LLM_BASE_URL: env.UNREAL_HARNESS_LLM_BASE_URL || connection.baseUrl,
    // The runner's OpenAI adapter requires a key, even for keyless local servers.
    UNREAL_HARNESS_LLM_API_KEY: env.UNREAL_HARNESS_LLM_API_KEY || apiKey || "local-model"
  };
}
