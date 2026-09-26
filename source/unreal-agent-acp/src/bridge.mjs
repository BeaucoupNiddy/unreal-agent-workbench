import * as acp from "@agentclientprotocol/sdk";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CapabilityBroker } from "./mcp.mjs";
import { sandboxLaunch } from "./sandbox.mjs";
import { snapshotWorkspace, workspaceDiff } from "./workspace.mjs";
import { packageVersion } from "./version.mjs";

const execFileAsync = promisify(execFile);
const appData = path.join(homedir(), "Library", "Application Support", "Unreal Agent ACP");
const hydraSessionRoot = path.join(process.env.HYDRA_ACP_HOME || path.join(homedir(), ".hydra-acp"), "sessions");
const consoleData = path.join(homedir(), "Library", "Application Support", "Unreal Agent Console");
const oneOffWorkspace = path.join(consoleData, "One-off Chats");
const projectMemoryRoot = path.join(consoleData, "project-memories");
const generationSettingsFile = path.join(consoleData, "generation-settings.json");
const harnessChatData = path.join(homedir(), "Library", "Application Support", "Harness Chat");
const defaultRunner = path.join(homedir(), ".local", "bin", "unreal-agent-runner");
const keychainService = "Harness Chat OpenRouter";
const keychainAccount = userInfo().username;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperBin = path.join(packageRoot, "bin");
const openRouterModelsUrl = "https://openrouter.ai/api/v1/models";
const openRouterCatalogMaxAgeMs = 6 * 60 * 60 * 1000;
const openRouterCatalogVersion = 2;
const retainedRuntimeAgeMs = 30 * 24 * 60 * 60 * 1000;
const maintenanceIntervalMs = 24 * 60 * 60 * 1000;

async function cleanupOldFiles(directory, cutoff = Date.now() - retainedRuntimeAgeMs) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await cleanupOldFiles(target, cutoff);
      const remaining = await fs.readdir(target).catch(() => ["unreadable"]);
      if (!remaining.length) await fs.rmdir(target).catch(() => {});
      return;
    }
    if (!entry.isFile()) return;
    const stat = await fs.stat(target).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.unlink(target).catch(() => {});
  }));
}

export function contentBlocksToPrompt(blocks) {
  const parts = [];
  for (const block of blocks || []) {
    if (block?.type === "text") {
      parts.push(block.text);
    } else if (block?.type === "resource_link") {
      parts.push(`[Referenced resource: ${block.name || block.uri}]\n${block.uri}`);
    } else if (block?.type === "resource") {
      const resource = block.resource || {};
      if (typeof resource.text === "string") {
        parts.push(`[Attached context: ${resource.uri || "resource"}]\n${resource.text}`);
      } else {
        parts.push(`[Attached resource: ${resource.uri || "resource"}]`);
      }
    }
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

export function capabilityInstructions(mcpServers = []) {
  if (!mcpServers.length) return [];
  const searchableText = mcpServers.map((server) => [
    server?.name,
    server?.command,
    server?.url,
    ...(Array.isArray(server?.args) ? server.args : [])
  ].filter(Boolean).join(" ")).join(" ");
  const hasWeb = /(^|[^a-z])(exa|web|search|brave|firecrawl|tavily|perplexity|searx)([^a-z]|$)/i.test(searchableText);
  const hasAppleProductivity = /apple-productivity/i.test(searchableText);
  const instructions = [
    "External tools are lazy: run `unreal-capability list [query]` to discover them, then `unreal-capability call <server> <tool> '<json>'`; Zed asks before first use."
  ];
  if (hasWeb) {
    instructions.push("For current, uncertain, or externally documented claims, search directly with `unreal-capability web-search '{\"objective\":\"specific research goal and preferred sources\",\"queries\":[\"focused query one\",\"focused query two\"]}'`. Put 1-4 related queries in ONE call; do not discover the web tool first or run sequential searches unless the first result is inadequate. You may request fewer sources or longer excerpts with `max_results` (1-8) and `max_chars_per_result` (200-5000). Search results are deduplicated and labeled S1, S2, etc.; cite their URLs for web-derived claims and prefer primary sources or official documentation. Only if excerpts are insufficient, fetch up to three promising URLs with `unreal-capability web-fetch '{\"urls\":[\"https://...\"],\"objective\":\"exact evidence needed\"}'`. Skip web search when local project evidence is sufficient.");
  }
  if (hasAppleProductivity) {
    instructions.push("For today's Apple Calendar, directly run `unreal-capability call apple-productivity calendar_today '{}'`; do not derive dates or list calendars first. Use `notes_search` directly for Apple Notes. If Apple access reports authorization or a timeout, do not retry—tell the user to grant macOS Privacy & Security access.");
  }
  return instructions;
}

export function parseHarnessEvent(event) {
  if (event?.type === "error") {
    return [{ kind: "message", role: "agent", text: `Harness error: ${event.message || "Unknown error"}` }];
  }
  if (event?.Kind === "model_response") {
    const output = event.Data?.Response?.Output || [];
    return output.flatMap((item) => {
      if (item.Type === "message" && item.Data?.Text) {
        return [{
          kind: "message",
          role: item.Data?.Phase === "analysis" ? "thought" : "agent",
          text: item.Data.Text,
          id: item.Data?.ID || item.Data?.Id
        }];
      }
      if (item.Type === "reasoning" && item.Data?.Summary?.length) {
        return [{ kind: "message", role: "thought", text: item.Data.Summary.join("\n") }];
      }
      if (item.Type === "tool_call") {
        const toolId = item.Data?.CallID || item.Data?.CallId || randomUUID();
        const name = item.Data?.Name || "Tool";
        return [{
          kind: "tool_start",
          id: toolId,
          title: toolTitle(name, item.Data?.Arguments),
          toolKind: toolKind(name),
          rawInput: safelyParseJson(item.Data?.Arguments)
        }];
      }
      return [];
    });
  }
  if (event?.Kind === "tool_call_status") {
    const operation = event.Data?.Operations?.[0];
    const result = operation?.State?.Result;
    const output = [result?.Out, result?.Err].filter(Boolean).join("\n").slice(-12000);
    return [{
      kind: "tool_update",
      id: event.Data?.CallID || event.Data?.CallId || operation?.ID || randomUUID(),
      status: mapToolStatus(operation?.Status, event.Data?.Status?.Error),
      error: event.Data?.Status?.Error || undefined,
      output: output || undefined,
      exitCode: result?.ExitCode
    }];
  }
  return [];
}

function safelyParseJson(value) {
  if (!value) return {};
  try { return JSON.parse(value); }
  catch { return { value: String(value) }; }
}

function toolTitle(name, argumentsText) {
  const args = safelyParseJson(argumentsText);
  if (name === "Bash" && args.command) {
    const firstLine = String(args.command).split("\n", 1)[0];
    return firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine;
  }
  if (name === "ViewImage" && args.path) return `View ${args.path}`;
  if (name === "SkillUse") return `Use skill ${args.name || ""}`.trim();
  return name;
}

function toolKind(name) {
  if (name === "Bash") return "execute";
  if (name === "ViewImage") return "read";
  return "other";
}

function mapToolStatus(status, error) {
  if (error || ["failed", "canceled"].includes(status)) return "failed";
  if (status === "completed") return "completed";
  if (["ready", "awaiting", "canceling"].includes(status)) return "in_progress";
  return "pending";
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return fallback; }
}

async function readHarnessChatSettings() {
  return readJson(path.join(harnessChatData, "settings.json"), {});
}

async function readOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password", "-a", keychainAccount, "-s", keychainService, "-w"
    ]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function resolveProviderConfig() {
  const saved = await readHarnessChatSettings();
  const provider = process.env.UNREAL_HARNESS_LLM_PROVIDER || saved.provider || "openai-codex";
  const model = process.env.UNREAL_HARNESS_LLM_MODEL || saved.model || "gpt-6-astra";
  return { provider, model };
}

const codexModels = [
  { value: "gpt-6-astra", name: "GPT-6 Astra" },
  { value: "gpt-6-luna", name: "GPT-6 Luna" },
  { value: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { value: "gpt-5.5", name: "GPT-5.5" }
];

const openRouterModelGroups = [
  { group: "openai", name: "OpenAI", options: [
    { value: "openai/gpt-6-astra", name: "GPT-6 Astra" },
    { value: "openai/gpt-6-astra-pro", name: "GPT-6 Astra Pro" },
    { value: "openai/gpt-6-luna", name: "GPT-6 Luna" },
    { value: "openai/gpt-6-luna-pro", name: "GPT-6 Luna Pro" },
    { value: "openai/gpt-6-sol", name: "GPT-6 Sol" },
    { value: "openai/gpt-6-sol-pro", name: "GPT-6 Sol Pro" }
  ] },
  { group: "anthropic", name: "Anthropic", options: [
    { value: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" },
    { value: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
    { value: "anthropic/claude-fable-5.1", name: "Claude Fable 5.1" }
  ] },
  { group: "google", name: "Google", options: [
    { value: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { value: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash" }
  ] },
  { group: "z-ai", name: "Z.AI", options: [
    { value: "z-ai/glm-5.3", name: "GLM 5.3" },
    { value: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { value: "z-ai/glm-5.3-flashx", name: "GLM 5.3 FlashX" }
  ] },
  { group: "deepseek", name: "DeepSeek", options: [
    { value: "deepseek/deepseek-v4-pro-0813", name: "DeepSeek V4 Pro" },
    { value: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }
  ] }
];

const recommendedOpenRouterModelIds = openRouterModelGroups
  .flatMap((group) => group.options.map((option) => option.value));

function contextLabel(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M context`;
  return `${Math.round(tokens / 1_000)}K context`;
}

// OpenRouter reports USD per token as decimal strings; show the text-token rates
// per million tokens rather than exposing tiny per-token fractions in the picker.
function pricePerMillion(raw) {
  if ((typeof raw !== "string" && typeof raw !== "number") || (typeof raw === "string" && !raw.trim())) return null;
  const amount = Number(raw) * 1_000_000;
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (amount > 0 && amount < 0.0000005) return "<$0.000001";
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(amount)}`;
}

function openRouterPriceLabel(pricing) {
  const input = pricePerMillion(pricing?.prompt);
  const output = pricePerMillion(pricing?.completion);
  if (input === null && output === null) return "";
  return [input !== null ? `${input} in` : "", output !== null ? `${output} out` : ""]
    .filter(Boolean).join(" / ") + " per 1M tokens";
}

export function parseOpenRouterModelCatalog(payload) {
  if (!Array.isArray(payload?.data)) throw new Error("OpenRouter returned an invalid model catalog.");
  const models = payload.data.flatMap((model) => {
    if (typeof model?.id !== "string" || !model.id.includes("/")) return [];
    const outputModalities = model.architecture?.output_modalities;
    if (Array.isArray(outputModalities) && !outputModalities.includes("text")) return [];
    const supported = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
    const price = openRouterPriceLabel(model.pricing);
    const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id;
    const details = [
      price,
      supported.includes("tools") ? "Tool calling" : "No declared tool calling",
      contextLabel(model.context_length)
    ].filter(Boolean).join(" • ");
    return [{
      value: model.id,
      ...(Number.isFinite(model.context_length) && model.context_length > 0 ? { contextWindow: model.context_length } : {}),
      name: price ? `${name} · ${price}` : name,
      ...(details ? { description: details } : {})
    }];
  });
  const unique = [...new Map(models.map((model) => [model.value, model])).values()];
  unique.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return unique;
}

// Favorites float to the top of the picker and the star is reserved for them;
// recommended models keep a prominent spot without wearing the star.
export function orderModelOptions(options, { favorites = [], recommended = [] } = {}) {
  const favoriteSet = new Set(favorites);
  const recommendedSet = new Set(recommended);
  const rank = (option) => favoriteSet.has(option.value) ? 0 : recommendedSet.has(option.value) ? 1 : 2;
  return options
    .map((option) => {
      const favorite = favoriteSet.has(option.value);
      const { favorite: _oldFavorite, recommended: _oldRecommended, ...base } = option;
      // Native ACP pickers ignore custom option metadata, so the label also
      // needs a star. The console uses `favorite` for its interactive button.
      return {
        ...base,
        name: `${favorite ? "★ " : ""}${option.name.replace(/^★\s+/, "")}`,
        ...(favorite ? { favorite: true } : {}),
        ...(recommendedSet.has(option.value) ? { recommended: true } : {})
      };
    })
    .sort((a, b) => rank(a) - rank(b));
}

// The catalog is cached with ★ labels from earlier versions; keep stripping
// them so only user favorites render a star.
function openRouterCatalogOptions(session) {
  const catalog = session.openRouterModels?.length
    ? structuredClone(session.openRouterModels)
    : openRouterModelGroups.flatMap((group) => group.options.map((option) => ({
      ...option, name: `${group.name}: ${option.name}`
    })));
  return catalog.map(({ value, name, description }) => ({
    value, name: name.replace(/^★ /, ""), ...(description ? { description } : {})
  }));
}

function modelOptions(session) {
  const favorites = session.favoriteModels || [];
  const options = session.provider === "openrouter"
    ? openRouterCatalogOptions(session)
    : structuredClone(codexModels);
  if (!options.some((option) => option.value === session.model)) {
    options.push({ value: session.model, name: `Current custom: ${session.model}` });
  }
  return orderModelOptions(options, {
    favorites,
    recommended: session.provider === "openrouter" ? recommendedOpenRouterModelIds : []
  });
}

function configOptions(session) {
  return [
    {
      id: "model",
      name: "Model",
      description: `Choose the model used for this Unreal Agent session through ${session.provider === "openrouter" ? "OpenRouter" : "OpenAI Codex"}.`,
      category: "model",
      type: "select",
      currentValue: session.model,
      options: modelOptions(session)
    },
    {
      id: "usage", name: "Usage",
      description: "Cumulative token usage and reported USD cost for this conversation. Cached input is included in input.",
      category: "usage", type: "select", currentValue: "summary", options: usageOptions(session.usage)
    },
    {
      id: "permission_mode",
      name: "Permissions",
      description: "Restrict writes to the project unless you explicitly select full access.",
      category: "mode",
      type: "select",
      currentValue: session.permissionMode,
      options: [
        { value: "read-only", name: "Read only" },
        { value: "workspace-write", name: "Workspace" },
        { value: "danger-full-access", name: "Full computer access" }
      ]
    },
    {
      id: "thought_level",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: session.thoughtLevel,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra high" },
        { value: "max", name: "Maximum" }
      ]
    }
  ];
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0,
    thoughtTokens: 0, cost: 0, costKnown: true, responses: [], lastContextTokens: 0 };
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// Compact labels only; ACP usage payloads and persisted counters remain exact.
export function formatTokenCount(value) {
  const tokens = tokenCount(value);
  if (tokens < 1_000) return String(tokens);
  const compact = (amount) => {
    const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return Number(amount.toFixed(digits));
  };
  if (tokens < 1_000_000) {
    const thousands = compact(tokens / 1_000);
    return thousands >= 1_000 ? "1m" : `${thousands}k`;
  }
  return `${compact(tokens / 1_000_000)}m`;
}

export function formatUsageCost(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "Unavailable";
}

function usageOptions(usage = emptyUsage()) {
  const count = formatTokenCount;
  const cost = usage.costKnown && usage.responses.length ? formatUsageCost(usage.cost) : "Unavailable";
  // Cached reads are part of input tokens, not additional tokens.
  const cachedPercent = usage.inputTokens > 0
    ? `${Math.round(100 * usage.cachedReadTokens / usage.inputTokens)}%`
    : "0%";
  return [
    // Zed truncates the selected label from the end, so cost leads the summary.
    { value: "summary", name: `Cost ${cost} · Input ${count(usage.inputTokens)} (${cachedPercent} cached) · Output ${count(usage.outputTokens)}` },
    { value: "cost", name: `Total cost ${cost} (${usage.responses.length} ${usage.responses.length === 1 ? "response" : "responses"})` },
    { value: "cached", name: `Cached input (read) ${count(usage.cachedReadTokens)} (${cachedPercent} of input) · Written ${count(usage.cachedWriteTokens)}` },
    { value: "total", name: `Total ${count(usage.inputTokens + usage.outputTokens)} · Reasoning ${count(usage.thoughtTokens)}` }
  ];
}

function recordUsage(session, response) {
  const usage = response?.Usage;
  if (!usage) return null;
  const state = session.usage ||= emptyUsage();
  // Runners can replay events on resume. A response is counted only once.
  if (response.ID && state.responses.includes(response.ID)) return null;
  if (response.ID) state.responses.push(response.ID);
  const delta = {
    inputTokens: tokenCount(usage.InputTokens), outputTokens: tokenCount(usage.OutputTokens),
    cachedReadTokens: tokenCount(usage.CachedInputTokens),
    cachedWriteTokens: tokenCount(usage.CacheWriteInputTokens),
    thoughtTokens: tokenCount(usage.ReasoningTokens)
  };
  for (const [key, value] of Object.entries(delta)) state[key] += value;
  state.lastContextTokens = delta.inputTokens + delta.outputTokens;
  // Provider-reported actual charge; catalog rates cannot accurately price a request.
  const cost = usage.Raw?.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) state.costKnown = false;
  else state.cost += cost;
  return delta;
}

function turnUsageResult(usage) {
  if (!usage.responses.length) return {};
  return { usage: { totalTokens: usage.inputTokens + usage.outputTokens,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cachedReadTokens: usage.cachedReadTokens, cachedWriteTokens: usage.cachedWriteTokens,
    thoughtTokens: usage.thoughtTokens } };
}

export class UnrealAgentBridge {
  constructor(options = {}) {
    this.runner = options.runner || process.env.UNREAL_AGENT_RUNNER || defaultRunner;
    this.dataDir = options.dataDir || appData;
    this.sessions = new Map();
    this.fetch = options.fetch || globalThis.fetch;
    this.openRouterCatalogPromise = null;
    this.favoriteModelsCache = null;
    this.favoriteToggleQueue = Promise.resolve();
    this.capabilitySocket = path.join(tmpdir(), `ua-cap-${process.pid}.sock`);
    this.capabilityBroker = new CapabilityBroker({
      socketPath: this.capabilitySocket, sessions: this.sessions, legacySocketDirectory: this.dataDir,
      projectHistoryRoot: options.projectHistoryRoot || hydraSessionRoot,
      projectMemoryRoot: options.projectMemoryRoot || projectMemoryRoot,
      generationSettingsFile: options.generationSettingsFile || generationSettingsFile
    });
    this.maintenancePromise = null;
    this.lastMaintenanceAt = 0;
  }

  openRouterCatalogPath() {
    return path.join(this.dataDir, "openrouter-models.json");
  }

  favoriteModelsPath() {
    return path.join(this.dataDir, "model-favorites.json");
  }

  async readFavoriteModels() {
    if (this.favoriteModelsCache) return this.favoriteModelsCache;
    const stored = await readJson(this.favoriteModelsPath(), []);
    this.favoriteModelsCache = Array.isArray(stored)
      ? [...new Set(stored.filter((id) => typeof id === "string" && id.trim()))]
      : [];
    return this.favoriteModelsCache;
  }

  async writeFavoriteModels(favorites) {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const target = this.favoriteModelsPath();
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(favorites, null, 2), { mode: 0o600 });
    await fs.rename(temporary, target);
    this.favoriteModelsCache = favorites;
  }

  async toggleFavoriteModel(session, modelId) {
    if (typeof modelId !== "string" || !modelOptions(session).some((option) => option.value === modelId)) {
      throw new Error("Unsupported model selection.");
    }
    // Serialize toggles from different browser tabs/sessions so concurrent
    // clicks cannot overwrite each other's changes on disk.
    const update = this.favoriteToggleQueue.then(async () => {
      const current = await this.readFavoriteModels();
      const favorites = current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId];
      await this.writeFavoriteModels(favorites);
      for (const active of this.sessions.values()) active.favoriteModels = favorites;
      return favorites;
    });
    this.favoriteToggleQueue = update.catch(() => {});
    return update;
  }

  async loadOpenRouterModels() {
    if (this.openRouterCatalogPromise) return this.openRouterCatalogPromise;
    this.openRouterCatalogPromise = this.refreshOpenRouterModels()
      .finally(() => { this.openRouterCatalogPromise = null; });
    return this.openRouterCatalogPromise;
  }

  async refreshOpenRouterModels() {
    const cachePath = this.openRouterCatalogPath();
    const cached = await readJson(cachePath, null);
    const cachedModels = Array.isArray(cached?.models) ? cached.models : [];
    if (cachedModels.length && cached.version === openRouterCatalogVersion && Date.now() - Number(cached.fetchedAt || 0) < openRouterCatalogMaxAgeMs) {
      return cachedModels;
    }
    try {
      const key = await readOpenRouterKey();
      const response = await this.fetch(openRouterModelsUrl, {
        headers: {
          Accept: "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {})
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error(`OpenRouter model catalog returned HTTP ${response.status}.`);
      const models = parseOpenRouterModelCatalog(await response.json());
      if (!models.length) throw new Error("OpenRouter model catalog was empty.");
      await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: openRouterCatalogVersion, fetchedAt: Date.now(), models }), { mode: 0o600 });
      await fs.rename(temporary, cachePath);
      return models;
    } catch (error) {
      if (cachedModels.length) return cachedModels;
      console.error("Unreal Agent ACP model catalog fallback:", error.message);
      return [];
    }
  }

  async initialize(params) {
    return {
      protocolVersion: Math.min(params.protocolVersion || acp.PROTOCOL_VERSION, acp.PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { embeddedContext: true },
        mcpCapabilities: { http: false, sse: false, acp: false },
        sessionCapabilities: { resume: {}, close: {} }
      },
      agentInfo: { name: "Unreal Agent", version: packageVersion }
    };
  }

  async newSession(params) {
    const cwd = await this.validateWorkspace(params.cwd);
    const provider = await resolveProviderConfig();
    const session = {
      id: `unreal-${randomUUID()}`,
      cwd,
      provider: provider.provider,
      model: provider.model,
      permissionMode: "workspace-write",
      thoughtLevel: "high",
      usage: emptyUsage(),
      mcpServers: params.mcpServers || [],
      projectHistoryEnabled: params._meta?.["unreal-agent"]?.projectHistory !== false && cwd !== oneOffWorkspace,
      fullAccessApproved: false,
      child: null
    };
    if (session.provider === "openrouter") {
      session.openRouterModels = await this.loadOpenRouterModels();
    }
    session.favoriteModels = await this.readFavoriteModels();
    this.sessions.set(session.id, session);
    await this.persistSession(session);
    return { sessionId: session.id, configOptions: configOptions(session) };
  }

  async resumeSession(params) {
    const stored = await readJson(this.sessionMetadataPath(params.sessionId), null);
    if (!stored) throw new Error(`Unknown Unreal Agent session: ${params.sessionId}`);
    const cwd = await this.validateWorkspace(params.cwd);
    if (path.resolve(stored.cwd) !== cwd) throw new Error("This session belongs to a different project folder.");
    const session = {
      ...stored,
      usage: stored.usage || emptyUsage(),
      cwd,
      permissionMode: stored.permissionMode || (stored.workspaceAccess === false ? "read-only" : "workspace-write"),
      mcpServers: params.mcpServers || stored.mcpServers || [],
      projectHistoryEnabled: stored.projectHistoryEnabled !== false && cwd !== oneOffWorkspace,
      fullAccessApproved: stored.permissionMode === "danger-full-access",
      child: null
    };
    if (session.provider === "openrouter") {
      session.openRouterModels = await this.loadOpenRouterModels();
    }
    session.favoriteModels = await this.readFavoriteModels();
    this.sessions.set(session.id, session);
    return { configOptions: configOptions(session) };
  }

  async closeSession(params) {
    const session = this.sessions.get(params.sessionId);
    if (session?.activeTurn) {
      session.activeTurn.cancelled = true;
      session.activeTurn.pendingSteers.length = 0;
    }
    if (session) {
      session.cancelled = true;
      this.interruptChild(session.child);
    }
    if (session) this.capabilityBroker.closeSession(session);
    this.sessions.delete(params.sessionId);
    return {};
  }

  async updateModel(session, model) {
    const allowedModels = modelOptions(session).map((option) => option.value);
    if (!allowedModels.includes(model)) throw new Error("Unsupported model selection.");
    session.model = model;
    await this.persistSession(session);
  }

  async setModel(params) {
    const session = this.requireSession(params.sessionId);
    await this.updateModel(session, params.modelId);
    return {};
  }

  async setConfigOption(params) {
    const session = this.requireSession(params.sessionId);
    if (params.configId === "permission_mode") {
      const allowed = new Set(["read-only", "workspace-write", "danger-full-access"]);
      if (!allowed.has(params.value)) throw new Error("Unsupported permission mode.");
      session.permissionMode = params.value;
      session.fullAccessApproved = params.value === "danger-full-access";
    } else if (params.configId === "model") {
      await this.updateModel(session, params.value);
    } else if (params.configId === "favorite_model") {
      await this.toggleFavoriteModel(session, params.value);
    } else if (params.configId === "usage") {
      if (!usageOptions(session.usage).some((item) => item.value === params.value)) {
        throw new Error("Unsupported usage selection.");
      }
      // The usage selector is a read-only detail popover.
    } else if (params.configId === "workspace_access" && params.type === "boolean") {
      session.permissionMode = params.value ? "workspace-write" : "read-only";
    } else if (params.configId === "thought_level") {
      const allowed = new Set(["low", "medium", "high", "xhigh", "max"]);
      if (!allowed.has(params.value)) throw new Error("Unsupported reasoning level.");
      session.thoughtLevel = params.value;
    } else {
      throw new Error(`Unknown configuration option: ${params.configId}`);
    }
    if (params.configId !== "model" && params.configId !== "favorite_model") await this.persistSession(session);
    return { configOptions: configOptions(session) };
  }

  async prompt(params, client) {
    const session = this.requireSession(params.sessionId);
    const prompt = contentBlocksToPrompt(params.prompt);
    if (!prompt) throw new Error("Enter a text prompt.");

    if (session.activeTurn) {
      // Keep the task/session alive, but restart the runner with the new user
      // input once its current tool operation is complete. If it is between
      // tools (including a model request), interrupt that cycle immediately.
      const turn = session.activeTurn;
      if (turn.cancelled) return turn.promise.then(() => this.prompt(params, client));
      turn.pendingSteers.push(prompt);
      turn.interruptRequested = true;
      if (!turn.interruptSent && turn.currentInputPersisted && turn.activeToolCalls.size === 0 && session.child?.exitCode === null) {
        turn.interruptSent = true;
        this.interruptChild(session.child);
      }
      return turn.promise;
    }

    const turn = {
      client,
      pendingSteers: [],
      interruptRequested: false,
      interruptSent: false,
      cancelled: false,
      activeToolCalls: new Set(),
      promise: null
    };
    session.activeTurn = turn;
    turn.promise = this.runSteeredPrompt(session, prompt, turn)
      .finally(() => {
        if (session.activeTurn === turn) session.activeTurn = null;
      });
    return turn.promise;
  }

  async runSteeredPrompt(session, initialPrompt, turn) {
    let nextInput = initialPrompt;
    const usage = {};
    let result;
    while (true) {
      if (turn.cancelled) {
        session.cancelled = false;
        return { stopReason: "cancelled", ...(Object.keys(usage).length ? { usage } : {}) };
      }
      if (Array.isArray(nextInput)) {
        nextInput.push(...turn.pendingSteers.splice(0));
      } else if (turn.pendingSteers.length) {
        nextInput = [nextInput, ...turn.pendingSteers.splice(0)];
      }
      turn.interruptRequested = false;
      turn.interruptSent = false;
      turn.currentInputPersisted = false;
      turn.activeToolCalls = new Set();
      result = await this.runPrompt(session, nextInput, turn.client, turn);
      if (result.usage) {
        for (const [key, value] of Object.entries(result.usage)) usage[key] = (usage[key] || 0) + value;
      }
      if (turn.cancelled || result.stopReason === "cancelled") {
        session.cancelled = false;
        return { stopReason: "cancelled", ...(Object.keys(usage).length ? { usage } : {}) };
      }
      if (!turn.pendingSteers.length) {
        return { ...result, ...(Object.keys(usage).length ? { usage } : {}) };
      }
      nextInput = turn.pendingSteers.splice(0);
    }
  }

  async runPrompt(session, prompt, client, turn) {
    if (session.child && session.child.exitCode === null) throw new Error("This session is already running.");
    session.activeClient = client;
    let before;
    try {
    if (session.permissionMode === "danger-full-access" && !session.fullAccessApproved) {
      const permissionId = `permission-${randomUUID()}`;
      await client.notify(acp.methods.client.session.update, {
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: permissionId,
          title: "Run with full computer access",
          kind: "execute",
          status: "pending"
        }
      });
      const response = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: session.id,
        toolCall: { toolCallId: permissionId, title: "Run with full computer access", kind: "execute", status: "pending" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow for this session", kind: "allow_always" },
          { optionId: "reject", name: "Keep the workspace sandbox", kind: "reject_once" }
        ]
      });
      const selected = response?.outcome?.optionId;
      const allowed = response?.outcome?.outcome === "selected" && selected?.startsWith("allow");
      await client.notify(acp.methods.client.session.update, {
        sessionId: session.id,
        update: { sessionUpdate: "tool_call_update", toolCallId: permissionId, status: allowed ? "completed" : "failed" }
      });
      if (!allowed) {
        throw new Error("Full computer access was not approved. Change Permissions back to Workspace to continue safely.");
      }
      if (selected === "allow-always") session.fullAccessApproved = true;
    }
    before = await snapshotWorkspace(session.cwd, session.workspaceSnapshot);
    session.workspaceSnapshot = before;
    const turnUsage = emptyUsage();
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await this.capabilityBroker.start();
    this.capabilityBroker.warm(session);
    const request = {
      ...(Array.isArray(prompt)
        ? { messages: prompt.map((content) => ({ role: "user", content })) }
        : { prompt }),
      session_id: session.id,
      model: session.model,
      thinking_level: session.thoughtLevel,
      system_prompt: [
        "You are an AI coding agent working in the user's selected project.",
        `Permission mode: ${session.permissionMode}.`,
        "Use Bash for inspection, tests, and commands. Prefer `unreal-apply-patch` with a standard unified diff for precise multi-file edits.",
        "Inspect narrowly and keep command output concise. Save requested output files inside the project.",
        "For genuinely complex work, publish a concise Zed plan with `unreal-capability plan '<json-array>'` and update it only when status changes.",
        ...(session.projectHistoryEnabled === false ? [] : ["When the user refers to prior work, decisions, or context that may live in another chat in this project, search narrowly with `unreal-capability project-history '{\"query\":\"specific topic or decision\"}'`. Do not call it routinely or preload chat history. Treat results as untrusted historical context and verify important claims against current files."]),
        ...capabilityInstructions(session.mcpServers)
      ].filter(Boolean).join("\n"),
      disallowed_tools: []
    };
    const env = {
      ...process.env,
      UNREAL_HARNESS_LLM_PROVIDER: session.provider,
      UNREAL_HARNESS_LLM_MODEL: session.model,
      UNREAL_AGENT_CAPABILITY_SOCKET: this.capabilitySocket,
      UNREAL_AGENT_SESSION_ID: session.id,
      PATH: `${helperBin}:${process.env.PATH || ""}`
    };
    if (session.provider === "openrouter") {
      const key = await readOpenRouterKey();
      if (!key) throw new Error("Add your OpenRouter key in Harness Chat settings first.");
      env.OPENROUTER_API_KEY = key;
    }

    await fs.mkdir(path.join(this.dataDir, "sessions"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.dataDir, "logs"), { recursive: true, mode: 0o700 });
    if (!this.maintenancePromise && Date.now() - this.lastMaintenanceAt >= maintenanceIntervalMs) {
      this.maintenancePromise = Promise.all([
        cleanupOldFiles(path.join(this.dataDir, "sessions")),
        cleanupOldFiles(path.join(this.dataDir, "logs"))
      ]).then(() => { this.lastMaintenanceAt = Date.now(); })
        .finally(() => { this.maintenancePromise = null; });
    }
    if (this.maintenancePromise) await this.maintenancePromise;
    const args = [
      "-workspace", session.cwd,
      "-session-directory", path.join(this.dataDir, "sessions"),
      "-log-directory", path.join(this.dataDir, "logs"),
      JSON.stringify(request)
    ];

    const launch = await sandboxLaunch({
      mode: session.permissionMode,
      runner: this.runner,
      args,
      cwd: session.cwd,
      dataDir: this.dataDir
    });
    const child = spawn(launch.command, launch.args, { env, cwd: session.cwd, stdio: ["ignore", "pipe", "pipe"] });
    session.child = child;
    if (turn?.cancelled || session.cancelled || (turn?.interruptRequested && turn.currentInputPersisted && turn.activeToolCalls.size === 0)) {
      this.interruptChild(child);
      if (turn) turn.interruptSent = true;
    }
    let stdout = "";
    let stderr = "";
    let failed = false;

    const emit = async (event) => {
      if (event?.Kind === "input" && event.Data?.Kind === "external" && turn) {
        turn.currentInputPersisted = true;
        if (turn.interruptRequested && !turn.interruptSent && !turn.cancelled && turn.activeToolCalls.size === 0) {
          turn.interruptSent = true;
          this.interruptChild(child);
        }
      }
      if (event?.Kind === "model_response") {
        for (const item of event.Data?.Response?.Output || []) {
          if (item.Type === "tool_call") {
            const callId = item.Data?.CallID || item.Data?.CallId;
            if (callId) turn?.activeToolCalls.add(callId);
          }
        }
        const delta = recordUsage(session, event.Data?.Response);
        if (delta) {
          for (const [key, value] of Object.entries(delta)) turnUsage[key] += value;
          turnUsage.responses.push(event.Data.Response.ID || randomUUID());
          await this.persistSession(session);
          const contextWindow = session.openRouterModels?.find((model) => model.value === session.model)?.contextWindow;
          await client.notify(acp.methods.client.session.update, {
            sessionId: session.id,
            update: {
              sessionUpdate: "usage_update",
              used: contextWindow ? session.usage.lastContextTokens : 0,
              size: contextWindow || 0,
              cost: session.usage.costKnown ? { amount: session.usage.cost, currency: "USD" } : null,
              _meta: { "unreal-agent/usage": {
                inputTokens: session.usage.inputTokens, outputTokens: session.usage.outputTokens,
                cachedReadTokens: session.usage.cachedReadTokens, cachedWriteTokens: session.usage.cachedWriteTokens
              } }
            }
          });
          await client.notify(acp.methods.client.session.update, {
            sessionId: session.id,
            update: { sessionUpdate: "config_option_update", configOptions: configOptions(session) }
          });
        }
      }
      if (event?.Kind === "tool_call_status" && turn) {
        const callId = event.Data?.CallID || event.Data?.CallId;
        const operations = event.Data?.Operations || [];
        const terminal = new Set(["completed", "failed", "canceled", "cancelled"]);
        const finished = Boolean(event.Data?.Status?.Error) ||
          (operations.length > 0 && operations.every((operation) => terminal.has(String(operation.Status).toLowerCase())));
        if (callId && finished) turn.activeToolCalls.delete(callId);
        if (turn.interruptRequested && !turn.interruptSent && !turn.cancelled && turn.activeToolCalls.size === 0) {
          turn.interruptSent = true;
          this.interruptChild(child);
        }
      }
      for (const update of parseHarnessEvent(event)) {
        if (update.kind === "message") {
          await client.notify(acp.methods.client.session.update, {
            sessionId: session.id,
            update: {
              sessionUpdate: update.role === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
              messageId: update.id,
              content: { type: "text", text: update.text }
            }
          });
        } else if (update.kind === "tool_start") {
          await client.notify(acp.methods.client.session.update, {
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: update.id,
              title: update.title,
              kind: update.toolKind,
              status: "pending",
              rawInput: update.rawInput
            }
          });
        } else if (update.kind === "tool_update") {
          const text = update.error || update.output;
          await client.notify(acp.methods.client.session.update, {
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: update.id,
              status: update.status,
              ...(text ? {
                content: [{ type: "content", content: { type: "text", text } }],
                rawOutput: { ...(update.error ? { error: update.error } : {}), ...(update.output ? { output: update.output } : {}), exitCode: update.exitCode }
              } : {})
            }
          });
        }
      }
    };

    const outputTask = (async () => {
      for await (const chunk of child.stdout) {
        stdout += chunk.toString("utf8");
        const lines = stdout.split("\n");
        stdout = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try { await emit(JSON.parse(line)); }
          catch (error) { console.error("Unreal Agent ACP event error:", error.message); }
        }
      }
      if (stdout.trim()) {
        try { await emit(JSON.parse(stdout)); }
        catch (error) { console.error("Unreal Agent ACP trailing event error:", error.message); }
      }
    })();
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-12000); });

    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).catch((error) => {
      failed = true;
      stderr = error.message;
      return -1;
    });
    await outputTask;
    if (code !== 0 || failed) {
      const cancelled = session.cancelled || turn?.cancelled;
      session.cancelled = false;
      if (cancelled) return { stopReason: "cancelled", ...turnUsageResult(turnUsage) };
      if (turn?.interruptRequested) return { stopReason: "steered", ...turnUsageResult(turnUsage) };
      throw new Error(stderr.trim() || `Unreal Agent exited with status ${code}.`);
    }
    return { stopReason: "end_turn", ...turnUsageResult(turnUsage) };
    } finally {
      session.child = null;
      session.activeClient = null;
      if (before) {
        try {
          const after = await snapshotWorkspace(session.cwd, before);
          session.workspaceSnapshot = after;
          const changes = workspaceDiff(before, after);
          if (changes.length) {
            const diffId = `workspace-diff-${randomUUID()}`;
            await client.notify(acp.methods.client.session.update, {
              sessionId: session.id,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: diffId,
                title: `${changes.length} file${changes.length === 1 ? "" : "s"} changed`,
                kind: "edit",
                status: "completed",
                content: changes,
                locations: changes.map((change) => ({ path: change.path }))
              }
            });
          }
        } catch (error) {
          console.error("Unreal Agent ACP workspace diff error:", error.message);
        }
      }
    }
  }

  interruptChild(child) {
    if (!child || child.exitCode !== null) return false;
    child.kill("SIGINT");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2500).unref();
    return true;
  }

  async cancel(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session || (!session.activeTurn && (!session.child || session.child.exitCode !== null))) return;
    session.cancelled = true;
    if (session.activeTurn) {
      session.activeTurn.cancelled = true;
      session.activeTurn.pendingSteers.length = 0;
    }
    this.interruptChild(session.child);
  }

  requireSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown Unreal Agent session: ${id}`);
    return session;
  }

  async validateWorkspace(value) {
    if (!value || !path.isAbsolute(value)) throw new Error("Zed must provide an absolute project folder.");
    const resolved = await fs.realpath(path.resolve(value)).catch(() => path.resolve(value));
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("The project folder does not exist.");
    return resolved;
  }

  sessionMetadataPath(id) {
    const safe = createHash("sha256").update(String(id)).digest("hex");
    return path.join(this.dataDir, "metadata", `${safe}.json`);
  }

  async persistSession(session) {
    await fs.mkdir(path.join(this.dataDir, "metadata"), { recursive: true, mode: 0o700 });
    const file = this.sessionMetadataPath(session.id);
    const temporary = `${file}.tmp`;
    const saved = {
      id: session.id,
      cwd: session.cwd,
      provider: session.provider,
      model: session.model,
      permissionMode: session.permissionMode,
      thoughtLevel: session.thoughtLevel,
      projectHistoryEnabled: session.projectHistoryEnabled !== false,
      usage: session.usage
    };
    await fs.writeFile(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
  }

  async close() {
    for (const session of this.sessions.values()) {
      if (session.child && session.child.exitCode === null) session.child.kill("SIGTERM");
    }
    await this.capabilityBroker.close();
  }
}

export function createAgentApp(bridge = new UnrealAgentBridge()) {
  return acp
    .agent({ name: "unreal-agent" })
    .onRequest("initialize", (ctx) => bridge.initialize(ctx.params))
    .onRequest("session/new", (ctx) => bridge.newSession(ctx.params))
    .onRequest("session/resume", (ctx) => bridge.resumeSession(ctx.params))
    .onRequest("session/close", (ctx) => bridge.closeSession(ctx.params))
    // Hydra prefers the dedicated model method. It is not in this SDK's v1
    // method table, so register it as a custom ACP method with a parser.
    .onRequest("session/set_model", (params) => params, (ctx) => bridge.setModel(ctx.params))
    .onRequest("session/set_config_option", (ctx) => bridge.setConfigOption(ctx.params))
    .onRequest("authenticate", async () => ({}))
    .onRequest("session/prompt", (ctx) => bridge.prompt(ctx.params, ctx.client))
    .onNotification("session/cancel", (ctx) => bridge.cancel(ctx.params));
}

export { acp };
