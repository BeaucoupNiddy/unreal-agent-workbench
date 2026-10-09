import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const catalogUrl = "https://chatgpt.com/backend-api/codex/models";
const maxAgeMs = 5 * 60 * 1000;
const retryDelayMs = 30 * 1000;

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(homedir(), ".codex");
}

// Catalogs contain runtime instructions too. Keep only picker metadata.
export function parseCodexModelCatalog(payload) {
  if (!Array.isArray(payload?.models)) throw new Error("Codex returned an invalid model catalog.");
  const models = payload.models.filter((model) => model && model.visibility !== "hide" && model.hidden !== true)
    .flatMap((model) => {
      const value = typeof model.slug === "string" ? model.slug.trim() : "";
      if (!value || value.length > 200 || /[\u0000-\u001f]/.test(value)) return [];
      return [{ value, name: typeof model.display_name === "string" && model.display_name.trim() ? model.display_name.trim() : value,
        ...(typeof model.description === "string" && model.description ? { description: model.description } : {}) }];
    });
  return [...new Map(models.map((model) => [model.value, model])).values()];
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

export class CodexModelCatalog {
  constructor({ dataDir, home = codexHome(), fetch = globalThis.fetch, now = Date.now } = {}) {
    this.cachePath = path.join(dataDir, "codex-models.json");
    this.home = home;
    this.fetch = fetch;
    this.now = now;
    this.pending = null;
    this.retryAt = 0;
  }

  async load({ force = false, cachedOnly = false } = {}) {
    // A force request following an automatic request must still contact Codex.
    if (this.pending) {
      if (!force || this.pendingForce) return this.pending;
      await this.pending;
      return this.load({ force, cachedOnly });
    }
    this.pendingForce = force;
    this.pending = this.refresh({ force, cachedOnly }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async refresh({ force, cachedOnly }) {
    const [stored, native] = await Promise.all([
      readJson(this.cachePath), readJson(path.join(this.home, "models_cache.json"))
    ]);
    let nativeModels = [];
    try { nativeModels = parseCodexModelCatalog(native); } catch { /* No native catalog yet. */ }
    const storedModels = Array.isArray(stored?.models) ? stored.models.filter((model) =>
      typeof model?.value === "string" && model.value && typeof model.name === "string") : [];
    const nativeAt = Date.parse(native?.fetched_at || "") || 0;
    const storedAt = Number(stored?.fetchedAt) || 0;
    const fallback = nativeModels.length && (!storedModels.length || nativeAt > storedAt)
      ? { models: nativeModels, fetchedAt: nativeAt } : { models: storedModels, fetchedAt: storedAt };
    const result = { ...fallback, source: fallback.models.length ? "cache" : "fallback" };
    if (!force && (cachedOnly || (fallback.models.length && this.now() - fallback.fetchedAt < maxAgeMs) || this.now() < this.retryAt)) return result;
    try {
      const auth = await readJson(path.join(this.home, "auth.json"));
      if (!auth?.tokens?.access_token) throw new Error("Sign in with Codex first (codex login).");
      const version = /^\d+\.\d+\.\d+$/.test(native?.client_version || "") ? native.client_version : "0.0.0";
      const response = await this.fetch(`${catalogUrl}?client_version=${encodeURIComponent(version)}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${auth.tokens.access_token}`,
          ...(auth.tokens.account_id ? { "ChatGPT-Account-Id": auth.tokens.account_id } : {}) },
        signal: AbortSignal.timeout(8000)
      });
      // Never include response bodies, which may contain account details.
      if (!response.ok) throw new Error(`Codex model catalog returned HTTP ${response.status}.`);
      const models = parseCodexModelCatalog(await response.json());
      if (!models.length) throw new Error("Codex model catalog was empty.");
      const fetchedAt = this.now();
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.cachePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ fetchedAt, models }), { mode: 0o600 });
      await fs.rename(temporary, this.cachePath);
      this.retryAt = 0;
      return { models, fetchedAt, source: "catalog" };
    } catch (error) {
      this.retryAt = this.now() + retryDelayMs;
      if (force) throw new Error(`Could not refresh the Codex model list: ${error.message}`);
      return result;
    }
  }
}
