import { subagentSavings, subagentUsage, usageDashboard } from "./usage-dashboard.mjs";
import { getSubscriptionUsage } from "./subscription-usage.mjs";
import { readCatalogModels, readModelUsageReference } from "./model-usage-reference.mjs";
import { captureSubscriptionBaseline, readSubscriptionBaseline, deleteSubscriptionBaseline } from "./subscription-baseline.mjs";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { ConsoleInputs } from "./console-inputs.mjs";
import { configuredMcpServers, readMcpSettings, saveMcpSettings } from "./mcp-settings.mjs";
import { readToolApprovals, removeToolApprovals, toolApprovalsFileName } from "../unreal-agent-acp/src/tool-approvals.mjs";
import { clearKaneoKey, normalizeKaneoUrl, readKaneoKey, saveKaneoKey, validKaneoKey, verifyKaneoKey } from "./kaneo.mjs";
import { assertManagedHydra, hydraServiceLabel } from "./hydra-service.mjs";
import { AutoTitleScheduler, recoverProvisionalTitle } from "./auto-title.mjs";
import { BackgroundGenerator, readBackgroundConnection, shouldGenerateAfterPrompt } from "./background-generation.mjs";
import { readDefaultModel, saveDefaultModel } from "./default-model.mjs";
import { readAgentSettings, saveAgentSettings } from "../unreal-agent-acp/src/agent-profiles.mjs";
import { clearOpenRouterKey, readOpenRouterKey, saveOpenRouterKey, validOpenRouterKey, verifyOpenRouterKey } from "../unreal-agent-acp/src/openrouter-key.mjs";
import { generationModels, readGenerationSettings, saveGenerationSettings } from "./generation-settings.mjs";
import { UnrealAgentBridge } from "../unreal-agent-acp/src/bridge.mjs";
import { browserActivityDirectory, readBrowserActivity, readBrowserImage } from "../unreal-agent-acp/src/browser-activity.mjs";
import { BrowserManager } from "../unreal-agent-acp/src/browser.mjs";
import { forgetSignIns, normalizeSignInUrl, signedInSites } from "../unreal-agent-acp/src/browser-sign-in.mjs";
import { readLocalProviders, saveLocalProvider, normalizeLocalProvider, discoverLocalModels } from "../unreal-agent-acp/src/local-providers.mjs";

import { searchChats } from "./chat-search.mjs";
import { TurnHistory } from "./turn-history.mjs";
import { CommandRunner } from "./command-runner.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const host = "127.0.0.1";
const port = Number(process.env.PORT || 4318);
const hydraDir = path.join(homedir(), ".hydra-acp");
const recoverableDraftAgeMs = 10 * 60 * 1000;
const appDataDir = path.join(homedir(), "Library", "Application Support", "Unreal Agent Console");
const projectsFile = path.join(appDataDir, "projects.json");
const removedProjectsFile = path.join(appDataDir, "removed-projects.json");
const oneOffWorkspaceDir = path.join(appDataDir, "One-off Chats");
const mcpSettingsFile = path.join(appDataDir, "mcp-settings.json");
const generationSettingsFile = path.join(appDataDir, "generation-settings.json");
const subscriptionBaselineDir = path.join(appDataDir, "subscription-baselines");
const projectMemoryDir = path.join(appDataDir, "project-memories");
const turnHistoryDir = path.join(appDataDir, "turn-timelines");
const agentDataDir = path.join(homedir(), "Library", "Application Support", "Unreal Agent ACP");
const catalogFile = path.join(agentDataDir, "openrouter-models.json");
const defaultModelFile = path.join(agentDataDir, "default-model.json");
const modelFavoritesFile = path.join(agentDataDir, "model-favorites.json");
const toolApprovalsFile = path.join(agentDataDir, toolApprovalsFileName);
const hydraCli = path.join(root, "..", "hydra-gateway", "node_modules", ".bin", "hydra-acp");
const appleMcpServer = path.join(root, "..", "apple-productivity-mcp", "server.mjs");
const kaneoMcpServer = path.join(root, "kaneo-mcp.mjs");
const runner = process.env.UNREAL_AGENT_RUNNER || path.join(homedir(), ".local", "bin", "unreal-agent-runner");
const execFileAsync = promisify(execFile);
const bridges = new Map();
const consoleInputs = new ConsoleInputs(appDataDir);
const baselineReads = new Map();
const modelCatalog = new UnrealAgentBridge({ dataDir: agentDataDir });
let hydraStart = null;
let favoriteUpdate = Promise.resolve();
const backgroundGenerator = new BackgroundGenerator({
  hydraSessionRoot: path.join(hydraDir, "sessions"),
  memoryRoot: projectMemoryDir,
  oneOffWorkspace: oneOffWorkspaceDir,
  runner,
  usageDataDir: agentDataDir,
  readSettings: () => readGenerationSettings(generationSettingsFile),
  readConnection: (meta) => readBackgroundConnection(agentDataDir, meta.upstreamSessionId),
  updateTitle: async (sessionId, title) => {
  await hydraJson(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    timeoutMs: 30_000
  });
  }
});
const autoTitles = new AutoTitleScheduler(async (sessionId) => {
  await backgroundGenerator.afterPrompt(sessionId, { generateTitle: true });
});

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 18 * 1024 * 1024) throw new Error("Request is too large (maximum 18 MB).");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Invalid JSON body."); }
}

async function readProjects() {
  try {
    const parsed = JSON.parse(await fs.readFile(projectsFile, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((project) => project && typeof project.id === "string" && typeof project.path === "string") : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function saveProjects(projects) {
  await fs.mkdir(appDataDir, { recursive: true });
  const temporary = `${projectsFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(projects, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, projectsFile);
}

async function readRemovedProjectPaths() {
  try {
    const parsed = JSON.parse(await fs.readFile(removedProjectsFile, "utf8"));
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item) => typeof item === "string" && path.isAbsolute(item)))] : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function saveRemovedProjectPaths(paths) {
  await fs.mkdir(appDataDir, { recursive: true });
  const temporary = `${removedProjectsFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify([...new Set(paths)], null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, removedProjectsFile);
}

async function updateProject(id, value) {
  const name = typeof value?.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 100) throw new Error("Enter a project name between 1 and 100 characters.");
  if (typeof value?.path !== "string" || !path.isAbsolute(value.path)) throw new Error("Choose an absolute folder path.");
  let canonicalPath;
  try { canonicalPath = await fs.realpath(value.path.trim()); }
  catch { throw new Error("That folder could not be found."); }
  const info = await fs.stat(canonicalPath);
  if (!info.isDirectory()) throw new Error("Choose a folder, not a file.");

  const projects = await readProjects();
  const project = projects.find((item) => item.id === id);
  if (!project) throw new Error("This project is no longer available.");
  if (projects.some((item) => item.id !== id && item.path === canonicalPath)) {
    throw new Error("Another project is already using that folder.");
  }
  project.name = name;
  project.path = canonicalPath;
  const removedPaths = await readRemovedProjectPaths();
  if (removedPaths.includes(canonicalPath)) await saveRemovedProjectPaths(removedPaths.filter((item) => item !== canonicalPath));
  await saveProjects(projects);
  return project;
}

async function removeProject(id) {
  const projects = await readProjects();
  const project = projects.find((item) => item.id === id);
  if (!project) throw new Error("This project is no longer available.");
  const removedPaths = await readRemovedProjectPaths();
  await saveRemovedProjectPaths([...removedPaths, project.path]);
  await saveProjects(projects.filter((item) => item.id !== id));
  return project;
}

async function readModelFavorites() {
  try {
    const parsed = JSON.parse(await fs.readFile(modelFavoritesFile, "utf8"));
    return Array.isArray(parsed) ? [...new Set(parsed.filter((id) => typeof id === "string" && id.trim()))] : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function toggleModelFavorite(modelId) {
  const update = favoriteUpdate.then(async () => {
    const current = await readModelFavorites();
    const added = !current.includes(modelId);
    const favorites = added ? [...current, modelId] : current.filter((id) => id !== modelId);
    await fs.mkdir(agentDataDir, { recursive: true, mode: 0o700 });
    const temporary = `${modelFavoritesFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(favorites, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, modelFavoritesFile);
    return { favorites, added };
  });
  favoriteUpdate = update.catch(() => {});
  return update;
}

// Hydra can retain workspace paths through compatibility symlinks. Give the sidebar
// canonical paths so a saved project and its old aliases resolve to one group.
async function canonicalWorkspacePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return value;
  try { return await fs.realpath(value); }
  catch { return path.normalize(value); }
}

// Hydra's public session list omits brand-new sessions until they have history.
// Recover recent console drafts so a refresh does not make an empty chat disappear.
async function listConsoleDraftSessions(sessions) {
  const knownIds = new Set(sessions.map((session) => session.sessionId));
  const draftRoot = path.join(hydraDir, "sessions");
  let directories;
  try { directories = await fs.readdir(draftRoot, { withFileTypes: true }); }
  catch { return []; }
  const drafts = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || !/^hydra_session_[A-Za-z0-9_-]+$/.test(directory.name) || knownIds.has(directory.name)) continue;
    const folder = path.join(draftRoot, directory.name);
    const metaPath = path.join(folder, "meta.json");
    let metaStat, historyStat;
    try { [metaStat, historyStat] = await Promise.all([fs.stat(metaPath), fs.stat(path.join(folder, "history.jsonl")).catch(() => null)]); }
    catch { continue; }
    if (historyStat?.size) continue;
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(metaPath, "utf8")); }
    catch { continue; }
    if (metadata.sessionId !== directory.name || metadata.agentId !== "unreal" || metadata.originatingClient?.name !== "unreal-agent-console") continue;
    const metadataTime = Date.parse(metadata.updatedAt || metadata.createdAt || "");
    const lastTouched = Number.isFinite(metadataTime) ? Math.max(metadataTime, metaStat.mtimeMs) : metaStat.mtimeMs;
    if (Date.now() - lastTouched > recoverableDraftAgeMs) continue;
    if (typeof metadata.cwd !== "string" || !path.isAbsolute(metadata.cwd)) continue;
    autoTitles.track(metadata.sessionId);
    drafts.push({
      sessionId: metadata.sessionId,
      upstreamSessionId: metadata.upstreamSessionId,
      cwd: await canonicalWorkspacePath(metadata.cwd),
      title: "New chat",
      agentId: "unreal",
      currentModel: metadata.currentModel,
      originatingClient: metadata.originatingClient,
      updatedAt: metadata.updatedAt || metadata.createdAt || metaStat.mtime.toISOString(),
      status: "cold",
      busy: false,
      attachedClients: 0,
      draft: true
    });
  }
  return drafts;
}

async function listSessions() {
  const result = await hydraJson("/v1/sessions?all=true");
  const sessions = await Promise.all((result.sessions || []).map(async (session) => ({
    ...session,
    cwd: await canonicalWorkspacePath(session.cwd)
  })));
  const drafts = await listConsoleDraftSessions(sessions);
  return {
    ...result,
    sessions: [...sessions, ...drafts].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  };
}

async function addProject(folderPath, projectName) {
  if (typeof folderPath !== "string" || !path.isAbsolute(folderPath)) throw new Error("Choose an absolute folder path.");
  let canonicalPath;
  try { canonicalPath = await fs.realpath(folderPath.trim()); }
  catch { throw new Error("That folder could not be found."); }
  const info = await fs.stat(canonicalPath);
  if (!info.isDirectory()) throw new Error("Choose a folder, not a file.");
  const projects = await readProjects();
  const existing = projects.find((project) => project.path === canonicalPath);
  if (existing) return existing;
  const name = typeof projectName === "string" && projectName.trim() ? projectName.trim() : path.basename(canonicalPath) || canonicalPath;
  if (name.length > 100) throw new Error("Enter a project name between 1 and 100 characters.");
  const removedPaths = await readRemovedProjectPaths();
  if (removedPaths.includes(canonicalPath)) await saveRemovedProjectPaths(removedPaths.filter((item) => item !== canonicalPath));
  const project = { id: randomUUID(), name, path: canonicalPath, createdAt: new Date().toISOString() };
  projects.push(project);
  await saveProjects(projects);
  return project;
}

async function chooseFolder() {
  if (process.platform !== "darwin") throw new Error("Use the folder path field to add a folder on this system.");
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a project folder")'], { timeout: 120_000 });
  return stdout.trim().replace(/\/$/, "") || "/";
}

async function hydraConfig() {
  const [token, daemonText] = await Promise.all([
    fs.readFile(path.join(hydraDir, "auth-token"), "utf8"),
    fs.readFile(path.join(hydraDir, "daemon.pid"), "utf8")
  ]);
  const daemon = JSON.parse(daemonText);
  const daemonHost = daemon.host || host;
  const daemonPort = daemon.port || 55514;
  return {
    token: token.trim(),
    httpUrl: `http://${daemonHost}:${daemonPort}`,
    wsUrl: `ws://${daemonHost}:${daemonPort}/acp`
  };
}

async function hydraIsReady() {
  try {
    const config = await hydraConfig();
    const response = await fetch(`${config.httpUrl}/v1/health`, {
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1200)
    });
    return response.ok;
  } catch { return false; }
}

async function ensureHydra() {
  // macOS must own the backend, even when a healthy manually started daemon exists.
  if (process.platform === "darwin") {
    const service = `gui/${process.getuid()}/${hydraServiceLabel}`;
    let output;
    try {
      ({ stdout: output } = await execFileAsync("/bin/launchctl", ["print", service], { timeout: 5000 }));
    } catch {
      throw new Error("The independent Unreal Agent backend service is not installed. Install launchd/local.unreal-agent.hydra.plist before starting the console.");
    }
    if (!(await hydraIsReady())) {
      await execFileAsync("/bin/launchctl", ["kickstart", service], { timeout: 5000 });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await hydraIsReady()) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      ({ stdout: output } = await execFileAsync("/bin/launchctl", ["print", service], { timeout: 5000 }));
    }
    const daemon = JSON.parse(await fs.readFile(path.join(hydraDir, "daemon.pid"), "utf8"));
    assertManagedHydra(output, daemon.pid);
    if (!(await hydraIsReady())) throw new Error("The Unreal Agent backend service is not ready.");
    return;
  }
  if (await hydraIsReady()) return;
  if (!hydraStart) {
    hydraStart = execFileAsync(hydraCli, ["daemon", "start"], { timeout: 12_000 })
      .catch((error) => { throw new Error(`Could not start Hydra: ${error.message}`); })
      .finally(() => { hydraStart = null; });
  }
  await hydraStart;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await hydraIsReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Hydra did not become ready.");
}

async function hydraJson(resource, options = {}) {
  await ensureHydra();
  const config = await hydraConfig();
  const { timeoutMs = 5000, ...requestOptions } = options;
  const response = await fetch(`${config.httpUrl}${resource}`, {
    ...requestOptions,
    headers: { Authorization: `Bearer ${config.token}`, ...(requestOptions.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Hydra returned ${response.status}.`);
  if (response.status === 204) return {};
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

class HydraConnection {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
    this.onNotification = () => {};
    this.onRequest = () => {};
  }

  async connect() {
    await ensureHydra();
    const config = await hydraConfig();
    this.socket = new WebSocket(`${config.wsUrl}?token=${encodeURIComponent(config.token)}`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Hydra connection timed out.")), 5000);
      this.socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Could not connect to Hydra.")); }, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("Hydra connection closed."));
      this.pending.clear();
    });
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "unreal-agent-console", title: "Unreal Agent Console", version: "0.1.0" }
    });
    return this;
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message || "Hydra request failed."));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) this.onRequest(message);
    else if (message.method) this.onNotification(message);
  }

  send(value) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Hydra is not connected.");
    this.socket.send(JSON.stringify(value));
  }

  request(method, params, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timeout });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }
  respond(id, result) { this.send({ jsonrpc: "2.0", id, result }); }
  reject(id, code, message) { this.send({ jsonrpc: "2.0", id, error: { code, message } }); }
  close() { this.socket?.close(); }
}

function hasAssistantText(content) {
  if (typeof content === "string") return Boolean(content);
  if (Array.isArray(content)) return content.some(hasAssistantText);
  if (!content || typeof content !== "object") return false;
  if (content.type === "image") return false;
  return (typeof content.text === "string" && Boolean(content.text)) || hasAssistantText(content.content);
}

class SessionBridge {
  constructor(sessionId, response) {
    this.sessionId = sessionId;
    this.initialResponse = response;
    this.responses = new Map([[response, { pending: null, lastSeq: -Infinity }]]);
    this.startPromise = null;
    this.stopped = false;
    this.connection = new HydraConnection();
    this.permissionRequests = new Map();
    this.heartbeat = null;
    this.disconnectTimer = null;
    this.permissionPayloads = new Map();
    this.configOptions = [];
    this.turnHistory = new TurnHistory(path.join(turnHistoryDir, `${sessionId}.json`));
    this.activePrompts = 0;
    this.inputs = typeof consoleInputs === "undefined" ? null : consoleInputs;
    this.inputRequests = new Set();
    this.queuedInputs = [];
    this.inputLock = Promise.resolve();
    this.cancelling = false;
  }

  emitTo(response, type, payload = {}) {
    if (response.destroyed || response.writableEnded) return;
    const viewer = this.responses.get(response);
    const seq = type === "hydra" ? payload.params?._meta?.["hydra-acp"]?.seq : undefined;
    if (viewer && Number.isFinite(seq)) {
      if (seq <= viewer.lastSeq) return;
      viewer.lastSeq = seq;
    }
    try { response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`); }
    catch { this.disconnect(response); }
  }

  emit(type, payload = {}) {
    for (const [response, viewer] of this.responses) {
      if (viewer.pending) viewer.pending.push({ type, payload });
      else this.emitTo(response, type, payload);
    }
  }

  start() {
    this.startPromise ||= this.initialize();
    return this.startPromise;
  }

  async initialize() {
    await this.turnHistory.load();
    await this.connection.connect();
    this.connection.onNotification = (message) => {
      const update = message.params?.update;
      if (update?.sessionUpdate === "permission_resolved" && update.toolCallId) {
        for (const [id, payload] of this.permissionPayloads) {
          if (payload.toolCall?.toolCallId === update.toolCallId) {
            this.permissionPayloads.delete(id);
            this.permissionRequests.delete(id);
          }
        }
      }
      const observedAt = Date.now();
      if (this.activePrompts) {
        if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") this.turnHistory.tool(update, observedAt);
        if (update?.sessionUpdate === "agent_message_chunk" && hasAssistantText(update.content)) this.turnHistory.response(observedAt);
        if (update?.sessionUpdate === "agent_thought_chunk") this.turnHistory.thought(update, observedAt);
      }
      this.emit("hydra", { ...message, observedAt });
    };
    this.connection.onRequest = (message) => {
      if (message.method === "session/request_permission") {
        this.permissionRequests.set(String(message.id), message.id);
        const payload = { requestId: String(message.id), ...message.params };
        this.permissionPayloads.set(String(message.id), payload);
        this.emit("permission", payload);
      } else {
        this.connection.reject(message.id, -32601, "This console does not provide filesystem or terminal access.");
      }
    };
    const recovered = this.inputs ? await this.inputs.pending(this.sessionId) : [];
    this.queuedInputs = recovered.filter(input => input.delivery === "queued");
    await this.attach(this.connection, this.initialResponse);
    for (const input of recovered.filter(input => input.delivery !== "queued")) {
      void this.prompt(input.text, input.attachments, input.inputId);
    }
    await this.drainQueue();
    await recoverProvisionalTitle(path.join(hydraDir, "sessions"), this.sessionId, autoTitles, () => {
      void autoTitles.afterPrompt(this.sessionId).catch((error) => {
        console.warn(`Title recovery failed for ${this.sessionId}: ${error.message}`);
      });
    });
  }

  async attach(connection, response) {
    const result = await connection.request("session/attach", {
      sessionId: this.sessionId,
      historyPolicy: "full",
      _meta: { "hydra-acp": { historyLimit: 0 } },
      clientInfo: { name: "unreal-agent-console", title: "Unreal Agent Console", version: "0.1.0" }
    }, 30_000);
    const modelFavorites = await readModelFavorites();
    if (this.stopped || !this.responses.has(response)) return;
    this.configOptions = result?.configOptions || [];
    const viewer = this.responses.get(response);
    // Live events buffered during replay must not be sent to other viewers again.
    // emitTo uses Hydra's monotonic sequence to suppress overlap between sockets,
    // including owner notifications that arrive after the replay's ready event.
    for (const frame of viewer.pending || []) {
      if (frame.type === "permission") continue; // Send the current approval snapshot below.
      this.emitTo(response, frame.type, frame.payload);
    }
    viewer.pending = null;
    this.emitTo(response, "ready", { ...(result || {}), modelFavorites,
      turnTimeline: this.turnHistory.snapshot(), activePrompts: this.activePrompts, queuedInputs: this.queuedInputs });
    for (const payload of this.permissionPayloads.values()) this.emitTo(response, "permission", payload);
    if (!this.heartbeat) this.heartbeat = setInterval(() => {
      for (const response of this.responses.keys()) {
        if (!response.destroyed && !response.writableEnded) response.write(": heartbeat\n\n");
      }
    }, 20_000);
  }

  async reconnect(response) {
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    this.responses.set(response, { pending: [], lastSeq: -Infinity });
    // Wait for the persistent owner to attach if a second device arrives during startup.
    await this.start();
    if (this.stopped || !this.responses.has(response)) return;
    // Hydra rejects a second attach on the same connection. Replay only to the
    // joining viewer, preserving the owner of prompts and approval requests.
    const replay = new HydraConnection();
    try {
      await replay.connect();
      replay.onNotification = (message) => {
        if (this.responses.has(response)) this.emitTo(response, "hydra", message);
      };
      replay.onRequest = (message) => replay.reject(message.id, -32601, "Approvals are handled by the persistent console connection.");
      await this.attach(replay, response);
    } finally {
      replay.close();
    }
  }

  disconnect(response) {
    if (!this.responses.delete(response) || this.responses.size || this.stopped) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    clearTimeout(this.disconnectTimer);
    // Only the LAST viewer leaving starts the approval-retention grace period.
    // Never auto-approve: wait for reconnection, then cancel on expiry.
    this.retainUntilIdle();
  }

  retainUntilIdle() {
    if (this.responses.size || this.stopped || this.activePrompts) return;
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = setTimeout(() => {
      if (this.activePrompts) return; // Keep the owner and approval state for active tasks.
      this.stop();
    }, 15 * 60_000);
    this.disconnectTimer.unref?.();
  }

  answerPermission(requestId, optionId) {
    const wireId = this.permissionRequests.get(requestId);
    if (wireId === undefined) return false;
    this.connection.respond(wireId, { outcome: { outcome: "selected", optionId } });
    this.permissionRequests.delete(requestId);
    this.permissionPayloads.delete(requestId);
    this.emit("console", { kind: "permission_answered", requestId });
    return true;
  }

  serializeInputs(operation) {
    const result = this.inputLock.then(operation);
    this.inputLock = result.catch(() => {});
    return result;
  }

  emitQueue() { this.emit("console", { kind: "queue_changed", queuedInputs: this.queuedInputs }); }

  promptContent(text, attachments = []) {
    return [...(text ? [{ type: "text", text }] : []), ...attachments.map(({ mimeType, data }) => ({ type: "image", mimeType, data }))];
  }

  // Hydra runs one session/prompt at a time per chat, so a message meant for the
  // running task goes through Hydra's steering request, which reaches the agent at once.
  async steerRunning(input) {
    let result;
    try {
      result = await this.connection.request("_session/steering", {
        sessionId: this.sessionId,
        prompt: this.promptContent(input.text, input.attachments),
        _meta: { steering: { idleBehavior: "promptRequired" } }
      }, 30_000);
    } catch {
      return "failed";
    }
    if (result?.outcome === "promptRequired") return "idle";
    if (!["injected", "startedNewTurn"].includes(result?.outcome)) return "failed";
    await this.inputs.complete(this.sessionId, input.inputId);
    // Hydra records the steer in the transcript but does not echo it to the client that sent it.
    if (input.text) this.emit("hydra", { method: "session/update", observedAt: Date.now(), params: { sessionId: this.sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: input.text }, _meta: { "hydra-acp": { steered: true } } } } });
    return "steered";
  }

  acceptInput(text, attachments, inputId, delivery = "auto") {
    return this.serializeInputs(async () => {
      if (this.stopped || this.cancelling) throw new Error("The task is stopping. Try again after it stops.");
      if (this.inputRequests.has(inputId)) {
        await this.inputs.save(this.sessionId, inputId, text, attachments, "sending");
        return { delivery: "sending" };
      }
      const existing = this.queuedInputs.find(input => input.inputId === inputId);
      if (existing) {
        if (existing.text !== text || JSON.stringify(existing.attachments) !== JSON.stringify(attachments)) throw new Error("Message recovery ID was reused for different content.");
        return { delivery: "queued" };
      }
      let mode = delivery !== "steer" && (this.activePrompts > 0 || this.queuedInputs.length > 0) ? "queued" : "sending";
      const input = await this.inputs.save(this.sessionId, inputId, text, attachments, mode);
      if (input.delivery !== mode) await this.inputs.setDelivery(this.sessionId, inputId, mode);
      if (mode === "sending" && this.activePrompts > 0) {
        const steered = await this.steerRunning({ inputId, text, attachments });
        if (steered === "steered") return { delivery: "steered" };
        if (steered === "failed") {
          mode = "queued";
          await this.inputs.setDelivery(this.sessionId, inputId, mode);
          this.emit("console", { kind: "queue_error", error: "The agent could not take that message mid-task, so it is queued to run next." });
        }
      }
      if (mode === "queued") {
        this.queuedInputs.push({ ...input, delivery: mode });
        this.queuedInputs.sort((a, b) => a.at - b.at);
        this.emitQueue();
      } else {
        void this.prompt(text, attachments, inputId);
      }
      return { delivery: mode };
    });
  }

  steerInput(inputId) {
    return this.serializeInputs(async () => {
      if (this.stopped || this.cancelling) throw new Error("The task is stopping.");
      const input = this.queuedInputs.find(input => input.inputId === inputId);
      // It may already have started naturally while the user clicked Steer.
      if (!input) return { delivery: "sending" };
      if (this.activePrompts > 0) {
        const steered = await this.steerRunning(input);
        if (steered === "failed") throw new Error("The agent could not take that message mid-task. It is still queued.");
        if (steered === "steered") {
          this.queuedInputs = this.queuedInputs.filter(input => input.inputId !== inputId);
          this.emitQueue();
          return { delivery: "steered" };
        }
      }
      await this.inputs.setDelivery(this.sessionId, inputId, "sending");
      this.queuedInputs = this.queuedInputs.filter(input => input.inputId !== inputId);
      this.emitQueue();
      void this.prompt(input.text, input.attachments, inputId);
      return { delivery: "sending" };
    });
  }

  removeQueuedInput(inputId) {
    return this.serializeInputs(async () => {
      if (!this.queuedInputs.some(input => input.inputId === inputId)) throw new Error("That message has already started.");
      await this.inputs.complete(this.sessionId, inputId);
      this.queuedInputs = this.queuedInputs.filter(input => input.inputId !== inputId);
      this.emitQueue();
    });
  }

  drainQueue() {
    return this.serializeInputs(async () => {
      if (this.stopped || this.cancelling || this.activePrompts || !this.queuedInputs.length) return;
      const input = this.queuedInputs[0];
      await this.inputs.setDelivery(this.sessionId, input.inputId, "sending");
      this.queuedInputs.shift();
      this.emitQueue();
      void this.prompt(input.text, input.attachments, input.inputId);
    });
  }

  cancelInputs() {
    return this.serializeInputs(async () => {
      this.cancelling = this.activePrompts > 0;
      this.connection.notify("session/cancel", { sessionId: this.sessionId });
      await this.inputs.discard(this.sessionId);
      this.queuedInputs = [];
      this.emitQueue();
    });
  }

  async prompt(text, attachments = [], inputId = randomUUID()) {
    if (this.inputRequests.has(inputId)) return;
    this.inputRequests.add(inputId);
    const turn = this.activePrompts ? this.turnHistory.turns.at(-1) : this.turnHistory.start();
    this.activePrompts += 1;
    let retired = false;
    let completed = false;
    const retire = () => { if (!retired) { this.activePrompts -= 1; retired = true; } };
    this.emit("console", { kind: "prompt_started", inputId, text, startedAt: turn.startedAt });
    try {
      const result = await this.connection.request("session/prompt", {
        sessionId: this.sessionId,
        _meta: { "unreal-agent/input-id": inputId },
        prompt: this.promptContent(text, attachments)
      }, 0); // Task completion is an agent event, not an elapsed-time limit.
      if (this.inputs && ["end_turn", "cancelled"].includes(result?.stopReason)) await this.inputs.complete(this.sessionId, inputId);
      completed = result?.stopReason === "end_turn";
      retire();
      const endedAt = Date.now();
      const outcome = ["cancelled", "steered"].includes(result?.stopReason) ? "interrupted" : "completed";
      if (!this.activePrompts) this.turnHistory.finish(outcome, endedAt);
      this.emit("console", { kind: "prompt_complete", inputId, result, endedAt, outcome });
      if (shouldGenerateAfterPrompt(result, this.activePrompts)) void autoTitles.afterPrompt(this.sessionId).then((handledTitle) => {
        if (!handledTitle) return backgroundGenerator.afterPrompt(this.sessionId);
      }).catch((error) => {
        console.warn(`Background generation failed for ${this.sessionId}: ${error.message}`);
      });
    } catch (error) {
      retire();
      const endedAt = Date.now();
      if (!this.activePrompts) this.turnHistory.finish("failed", endedAt);
      this.emit("console", { kind: "prompt_error", inputId, error: error.message, endedAt });
    } finally {
      retire();
      this.inputRequests.delete(inputId);
      if (!this.activePrompts) this.cancelling = false;
      if (completed) void this.drainQueue().catch(error => this.emit("console", { kind: "queue_error", error: error.message }));
      this.retainUntilIdle();
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.disconnectTimer);
    for (const id of this.permissionRequests.values()) {
      try { this.connection.respond(id, { outcome: { outcome: "cancelled" } }); } catch {}
    }
    this.permissionRequests.clear();
    this.permissionPayloads.clear();
    this.connection.close();
    for (const response of this.responses.keys()) {
      if (!response.destroyed && !response.writableEnded) response.end();
    }
    this.responses.clear();
    if (bridges.get(this.sessionId) === this) bridges.delete(this.sessionId);
  }
}

async function sessionUsageDetails(sessionId) {
  const meta = await readAgentMetadata(sessionId);
  if (!meta) return null;
  let baseline = await readSubscriptionBaseline(subscriptionBaselineDir, sessionId);
  if (!baseline && ['openai-codex', 'claude-code'].includes(meta.provider)) {
    // Older threads had no creation snapshot. Start tracking on first view;
    // never present this first-observed value as usage since creation.
    if (!baselineReads.has(sessionId)) baselineReads.set(sessionId,
      captureSubscriptionBaseline(subscriptionBaselineDir, sessionId, meta.provider, getSubscriptionUsage, 'first-observed')
        .catch(() => null).finally(() => baselineReads.delete(sessionId)));
    baseline = await baselineReads.get(sessionId);
  }
  const reference = await readModelUsageReference(catalogFile, meta.provider, meta.model);
  const { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, lastContextTokens, cost, costKnown } = meta.usage || {};
  return { provider: meta.provider, model: meta.model, baseline, reference,
    usage: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens,
      used: lastContextTokens, size: reference?.contextWindow || 0,
      cost: costKnown && Number.isFinite(cost) ? { amount: cost, currency: 'USD' } : null },
    subagents: subagentUsage(meta.usage?.events),
    subagentSavings: subagentSavings(meta.usage?.events, meta, await readCatalogModels(catalogFile)) };
}

// The Kaneo key is checked with the instance before it reaches the keychain.
async function saveCapabilities(body) {
  const kaneoUrl = normalizeKaneoUrl(body?.kaneoUrl);
  const newKey = typeof body?.kaneoApiKey === "string" && body.kaneoApiKey.trim() ? validKaneoKey(body.kaneoApiKey) : "";
  if (body?.kaneo === true && !kaneoUrl) throw new Error("Enter your Kaneo address to turn Kaneo on.");
  let kaneoCheck = null;
  if (newKey) {
    if (!kaneoUrl) throw new Error("Enter your Kaneo address before saving its API key.");
    kaneoCheck = await verifyKaneoKey(kaneoUrl, newKey);
    if (!kaneoCheck.valid) throw new Error("Kaneo rejected that API key. Check the address and copy the whole key from Kaneo.");
  }
  const settings = await saveMcpSettings(mcpSettingsFile, { ...body, kaneoUrl });
  if (newKey) await saveKaneoKey(newKey);
  else if (body?.clearKaneoKey === true) await clearKaneoKey();
  return { settings, kaneoKeySaved: Boolean(await readKaneoKey()), kaneoCheck, appliesTo: "new-chats" };
}

async function createSession(body) {
  const connection = await new HydraConnection().connect();
  try {
    const mcpSettings = await readMcpSettings(mcpSettingsFile);
    const result = await connection.request("session/new", {
      cwd: body.cwd,
      mcpServers: configuredMcpServers(mcpSettings, { nodePath: process.execPath, appleServerPath: appleMcpServer, kaneoServerPath: kaneoMcpServer }),
      _meta: {
        "hydra-acp": { agentId: "unreal", ...(body.title ? { title: body.title } : {}) },
        "unreal-agent": { projectHistory: body.oneOff !== true }
      }
    }, 30_000);
    if (!body.title) autoTitles.track(result?.sessionId);
    const provider = result?._meta?.["unreal-agent/provider"]
      || (result?.configOptions?.find((option) => option.id === 'model')?.description?.includes('Claude Code') ? 'claude-code'
        : result?.configOptions?.find((option) => option.id === 'model')?.description?.includes('OpenAI Codex') ? 'openai-codex' : null);
    try { await captureSubscriptionBaseline(subscriptionBaselineDir, result?.sessionId, provider, getSubscriptionUsage); }
    catch (error) { console.warn(`Could not capture subscription baseline: ${error.message}`); }
    return result;
  } finally {
    connection.close();
  }
}

async function readAgentMetadata(sessionId) {
  const list = await hydraJson("/v1/sessions?all=true");
  const session = list.sessions?.find((entry) => entry.sessionId === sessionId);
  if (!session?.upstreamSessionId?.startsWith('unreal-')) return null;
  const hash = createHash('sha256').update(session.upstreamSessionId).digest('hex');
  let meta;
  try { meta = JSON.parse(await fs.readFile(path.join(agentDataDir, 'metadata', `${hash}.json`), 'utf8')); }
  catch { return null; }
  return meta.id === session.upstreamSessionId ? meta : null;
}

// The visible sign-in window for the agents' browser runs from the console,
// which is the process the user is looking at.
const signInBrowser = new BrowserManager({ dataDir: agentDataDir });
let signInError = "";
async function signInStatus() {
  const settings = await readMcpSettings(mcpSettingsFile).catch(() => ({}));
  return { sites: await signedInSites(agentDataDir), open: signInBrowser.signInOpen, error: signInError,
    suggestedUrl: settings?.kaneo && settings?.kaneoUrl ? settings.kaneoUrl : "" };
}

// Console chat → the bridge chat whose browser steps the Browser panel shows.
const browserChats = new Map();
async function browserDirectoryFor(sessionId) {
  const cached = browserChats.get(sessionId);
  if (cached && (cached.id || Date.now() - cached.checkedAt < 15_000)) return cached.id ? browserActivityDirectory(agentDataDir, cached.id) : null;
  const meta = await readAgentMetadata(sessionId).catch(() => null);
  browserChats.set(sessionId, { id: meta?.id || null, checkedAt: Date.now() });
  return meta?.id ? browserActivityDirectory(agentDataDir, meta.id) : null;
}

const commandRunner = new CommandRunner({ resolveAccess: async (sessionId) => {
  const meta = await readAgentMetadata(sessionId);
  if (!meta || typeof meta.cwd !== "string" || !path.isAbsolute(meta.cwd)) return null;
  return { cwd: meta.cwd, mode: meta.permissionMode || "workspace-write", writableFolders: meta.writableFolders || [] };
} });

// Streams newline-delimited JSON frames; closing the request stops the command.
async function runCommand(req, res, sessionId) {
  const body = await readJson(req);
  if (commandRunner.isRunning(sessionId)) return json(res, 409, { error: "A command is already running in this chat. Stop it first." });
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  const emit = (frame) => { if (!res.writableEnded) res.write(`${JSON.stringify(frame)}\n`); };
  res.on("close", () => { if (!res.writableFinished) commandRunner.stop(sessionId); });
  try { await commandRunner.run(sessionId, body.command, emit); }
  catch (error) { emit({ type: "error", message: error.message }); }
  res.end();
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const requestHost = req.headers.host;
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(requestHost) && parsed.host.toLowerCase() === requestHost.toLowerCase();
  } catch {
    return false;
  }
}

function safeSessionId(value) {
  return /^hydra_session_[A-Za-z0-9_-]+$/.test(value || "") ? value : null;
}

async function serveStatic(req, res, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(publicDir, `.${requestPath}`);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) return json(res, 404, { error: "Not found" });
  try {
    const body = await fs.readFile(filePath);
    const mime = {
      ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json; charset=utf-8"
    }[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": mime, "cache-control": "no-cache", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(body);
  } catch { json(res, 404, { error: "Not found" }); }
}

const server = createServer(async (req, res) => {
  try {
    if (!checkOrigin(req)) return json(res, 403, { error: "Origin not allowed." });
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(events|prompt|steer|remove-queued|cancel|config|favorite-model|permission|subscription-baseline|usage-details|command|command-stop))?$/);

    if (req.method === "GET" && url.pathname === "/api/projects") {
      const [projects, removedProjectPaths] = await Promise.all([readProjects(), readRemovedProjectPaths()]);
      return json(res, 200, { projects, removedProjectPaths, oneOffWorkspacePath: oneOffWorkspaceDir });
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && req.method === "PATCH") {
      const id = decodeURIComponent(projectMatch[1]);
      try { return json(res, 200, { project: await updateProject(id, await readJson(req)) }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (projectMatch && req.method === "DELETE") {
      const id = decodeURIComponent(projectMatch[1]);
      try {
        const project = await removeProject(id);
        return json(res, 200, { project, removedProjectPaths: await readRemovedProjectPaths() });
      } catch (error) { return json(res, 404, { error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/capabilities") {
      return json(res, 200, { settings: await readMcpSettings(mcpSettingsFile), kaneoKeySaved: Boolean(await readKaneoKey()), appliesTo: "new-chats" });
    }
    if (req.method === "PUT" && url.pathname === "/api/capabilities") {
      const body = await readJson(req);
      try { return json(res, 200, await saveCapabilities(body)); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/tool-approvals") {
      return json(res, 200, { tools: await readToolApprovals(toolApprovalsFile) });
    }
    if (req.method === "DELETE" && url.pathname === "/api/tool-approvals") {
      const body = await readJson(req);
      return json(res, 200, { tools: await removeToolApprovals(toolApprovalsFile, body?.tools || []) });
    }
    if (req.method === "GET" && url.pathname === "/api/default-model") {
      return json(res, 200, { settings: await readDefaultModel(defaultModelFile), appliesTo: "new-chats" });
    }
    if (req.method === "GET" && url.pathname === "/api/usage-dashboard") {
      const { sessions } = await listSessions();
      return json(res, 200, await usageDashboard(sessions, { metadataDir: path.join(agentDataDir, "metadata"), catalogFile }));
    }
    if (req.method === "GET" && url.pathname === "/api/subscription-usage") {
      const provider = url.searchParams.get("provider");
      if (!["claude-code", "openai-codex"].includes(provider)) return json(res, 400, { error: "Choose Claude Code or Codex." });
      return json(res, 200, await getSubscriptionUsage(provider, { force: url.searchParams.get("fresh") === "1" }));
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      return json(res, 200, await modelCatalog.providerCatalog());
    }
    if (req.method === "POST" && url.pathname === "/api/models/refresh") {
      const body = await readJson(req);
      if (typeof body.provider !== "string") return json(res, 400, { error: "Choose a valid provider." });
      const catalog = await modelCatalog.providerCatalog({ refreshProvider: body.provider });
      await Promise.allSettled([...bridges.values()].map(async (bridge) => {
        const result = await bridge.connection.request("session/set_config_option", {
          sessionId: bridge.sessionId, configId: "refresh_models", value: "cached"
        }, 30_000);
        if (result?.configOptions) {
          bridge.configOptions = result.configOptions;
          bridge.emit("hydra", { method: "session/update", params: { sessionId: bridge.sessionId,
            update: { sessionUpdate: "config_option_update", configOptions: result.configOptions } } });
        }
      }));
      return json(res, 200, catalog);
    }
    if (req.method === "POST" && url.pathname === "/api/local-providers/test") {
      const body = await readJson(req);
      const previous = body.id ? (await readLocalProviders(agentDataDir)).find((item) => item.id === body.id) : undefined;
      if (body.id && !previous) return json(res, 400, { error: "This local connection no longer exists." });
      try {
        const connection = normalizeLocalProvider(body, previous);
        return json(res, 200, { models: await discoverLocalModels(connection) });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/local-providers") {
      try {
        const provider = await saveLocalProvider(agentDataDir, await readJson(req));
        return json(res, 200, { provider, ...await modelCatalog.providerCatalog() });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === "PUT" && url.pathname === "/api/default-model") {
      try {
        const body = await readJson(req);
        if (body.provider?.startsWith("local-") && !(await readLocalProviders(agentDataDir)).some((item) => item.id === body.provider)) {
          return json(res, 400, { error: "Add this local connection before choosing it as the default." });
        }
        return json(res, 200, { settings: await saveDefaultModel(defaultModelFile, body), appliesTo: "new-chats" });
      }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (url.pathname === "/api/openrouter-key") {
      // The key itself is never sent back to the page.
      if (req.method === "GET") return json(res, 200, { configured: Boolean(await readOpenRouterKey()) });
      if (req.method === "DELETE") { await clearOpenRouterKey(); return json(res, 200, { configured: Boolean(await readOpenRouterKey()) }); }
      if (req.method === "PUT") {
        try {
          const key = validOpenRouterKey((await readJson(req)).key);
          const check = await verifyOpenRouterKey(key);
          if (!check.valid) return json(res, 400, { error: "OpenRouter rejected that key. Check it at openrouter.ai/keys." });
          await saveOpenRouterKey(key);
          return json(res, 200, { configured: true, verified: check.checked });
        } catch (error) { return json(res, 400, { error: error.message }); }
      }
    }
    if (req.method === "GET" && url.pathname === "/api/agents") {
      return json(res, 200, { settings: await readAgentSettings(agentDataDir) });
    }
    if (req.method === "PUT" && url.pathname === "/api/agents") {
      try {
        const body = await readJson(req);
        const locals = new Set((await readLocalProviders(agentDataDir)).map((item) => item.id));
        const missing = (Array.isArray(body.subagents) ? body.subagents : []).find((agent) => agent?.provider?.startsWith("local-") && !locals.has(agent.provider));
        if (missing) return json(res, 400, { error: `Add the local connection for ${missing.name || "this subagent"} before using it.` });
        return json(res, 200, { settings: await saveAgentSettings(agentDataDir, body) });
      }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/generation-settings") {
      return json(res, 200, { settings: await readGenerationSettings(generationSettingsFile), models: generationModels });
    }
    if (req.method === "PUT" && url.pathname === "/api/generation-settings") {
      const settings = await saveGenerationSettings(generationSettingsFile, await readJson(req));
      return json(res, 200, { settings, models: generationModels });
    }
    if (req.method === "POST" && url.pathname === "/api/projects") {
      const body = await readJson(req);
      try { return json(res, 201, { project: await addProject(body.path, body.name) }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/choose-folder") {
      const folderPath = await chooseFolder();
      return json(res, 200, { path: folderPath });
    }
    if (req.method === "GET" && url.pathname === "/api/activity") {
      // Used by the everyday-install updater to restart only while idle.
      const activePrompts = [...bridges.values()].reduce((total, bridge) => total + (bridge.activePrompts || 0), 0);
      return json(res, 200, { activePrompts, runningCommands: commandRunner.running.size });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const health = await hydraJson("/v1/health");
      return json(res, 200, { ready: true, health });
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return json(res, 200, await listSessions());
    }
    if (req.method === "GET" && url.pathname === "/api/chat-search") {
      const query = (url.searchParams.get("q") || "").trim();
      if (query.length > 120) return json(res, 400, { error: "Search must be 120 characters or fewer." });
      if (!query) return json(res, 200, { results: [] });
      const { sessions } = await listSessions();
      return json(res, 200, { results: await searchChats({ sessions, sessionRoot: path.join(hydraDir, "sessions"), query }) });
    }
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(req);
      if (body.oneOff === true) {
        await fs.mkdir(oneOffWorkspaceDir, { recursive: true, mode: 0o700 });
        body.cwd = oneOffWorkspaceDir;
      }
      if (!body.cwd || !path.isAbsolute(body.cwd)) return json(res, 400, { error: "Choose an absolute workspace path." });
      return json(res, 201, await createSession(body));
    }
    if (req.method === "POST" && url.pathname === "/api/open-zed") {
      const body = await readJson(req);
      const cwd = String(body.cwd || "");
      if (!path.isAbsolute(cwd)) return json(res, 400, { error: "That workspace is not attached to a known task." });
      const canonicalCwd = await canonicalWorkspacePath(cwd);
      const sessions = await listSessions();
      if (!(sessions.sessions || []).some((item) => item.cwd === canonicalCwd)) {
        return json(res, 400, { error: "That workspace is not attached to a known task." });
      }
      await execFileAsync("/usr/bin/open", ["-a", "Zed", canonicalCwd], { timeout: 10_000 });
      return json(res, 200, { opened: true });
    }
    if (url.pathname === "/api/browser/sign-ins") {
      if (req.method === "GET") return json(res, 200, await signInStatus());
      if (req.method === "POST") {
        let address;
        try { address = normalizeSignInUrl((await readJson(req)).url); }
        catch (error) { return json(res, 400, { error: error.message }); }
        if (signInBrowser.signInOpen) return json(res, 409, { error: "A sign-in window is already open. Close it first." });
        signInError = "";
        signInBrowser.openSignInWindow(address).catch((error) => { signInError = error.message || "The sign-in window could not open."; });
        return json(res, 202, await signInStatus());
      }
      if (req.method === "DELETE") {
        await forgetSignIns(agentDataDir, url.searchParams.get("site") || "");
        return json(res, 200, await signInStatus());
      }
    }
    const browserMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/browser(?:\/image\/([^/]+))?$/);
    if (browserMatch && req.method === "GET") {
      const sessionId = safeSessionId(decodeURIComponent(browserMatch[1]));
      if (!sessionId) return json(res, 400, { error: "Invalid session." });
      const directory = await browserDirectoryFor(sessionId);
      if (browserMatch[2]) {
        const name = decodeURIComponent(browserMatch[2]);
        const image = directory ? await readBrowserImage(directory, name) : null;
        if (!image) return json(res, 404, { error: "Not found" });
        res.writeHead(200, { "content-type": name.endsWith(".png") ? "image/png" : "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(image);
      }
      if (!directory) return json(res, 200, { total: 0, reset: false, entries: [], agents: [] });
      return json(res, 200, await readBrowserActivity(directory, { after: url.searchParams.get("after") }));
    }
    if (match) {
      const sessionId = safeSessionId(decodeURIComponent(match[1]));
      const action = match[2];
      if (!sessionId) return json(res, 400, { error: "Invalid session." });
      if (req.method === "GET" && action === "usage-details") {
        const details = await sessionUsageDetails(sessionId);
        return details ? json(res, 200, details) : json(res, 404, { error: 'Usage details are not available yet.' });
      }
      if (req.method === "GET" && action === "subscription-baseline") {
        return json(res, 200, { baseline: await readSubscriptionBaseline(subscriptionBaselineDir, sessionId) });
      }
      if (req.method === "GET" && action === "events") {
        const existing = bridges.get(sessionId);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
          connection: "keep-alive", "x-accel-buffering": "no"
        });
        res.write("retry: 2000\n\n");
        const bridge = existing || new SessionBridge(sessionId, res);
        bridges.set(sessionId, bridge);
        res.on("close", () => bridge.disconnect(res));
        try {
          if (existing) await bridge.reconnect(res);
          else await bridge.start();
        }
        catch (error) {
          bridge.emitTo(res, "fault", { error: error.message });
          if (existing) {
            bridge.disconnect(res);
            if (!res.destroyed && !res.writableEnded) res.end();
          } else bridge.stop();
        }
        return;
      }
      if (req.method === "DELETE" && !action) {
        await hydraJson(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", timeoutMs: 30_000 });
        await deleteSubscriptionBaseline(subscriptionBaselineDir, sessionId);
        await consoleInputs.discard(sessionId);
        const bridge = bridges.get(sessionId);
        await bridge?.turnHistory.pending.catch(() => {});
        await fs.rm(path.join(turnHistoryDir, `${sessionId}.json`), { force: true });
        if (bridge) {
          bridge.stop();
        }
        return json(res, 200, { deleted: true });
      }
      if (req.method === "POST" && action === "command") return runCommand(req, res, sessionId);
      if (req.method === "POST" && action === "command-stop") return json(res, 200, { stopped: commandRunner.stop(sessionId) });
      const bridge = bridges.get(sessionId);
      if (!bridge) return json(res, 409, { error: "Open the task before controlling it." });
      const body = await readJson(req);
      if (req.method === "POST" && action === "prompt") {
        const text = String(body.text || "").trim();
        const attachments = Array.isArray(body.attachments) ? body.attachments : [];
        if (!text && !attachments.length) return json(res, 400, { error: "Write a message or attach an image first." });
        if (attachments.length > 4) return json(res, 400, { error: "Attach up to 4 images per message." });
        const allowedTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
        let totalBytes = 0;
        for (const image of attachments) {
          if (!allowedTypes.has(image?.mimeType) || typeof image?.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
            return json(res, 400, { error: "Images must be PNG, JPEG, GIF, or WebP." });
          }
          const bytes = Math.floor(image.data.length * 3 / 4);
          if (!bytes || bytes > 3 * 1024 * 1024) return json(res, 400, { error: "Each image must be 3 MB or smaller." });
          totalBytes += bytes;
        }
        if (totalBytes > 12 * 1024 * 1024) return json(res, 400, { error: "Images must total 12 MB or less." });
        const inputId = body.inputId || randomUUID();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inputId)) return json(res, 400, { error: "Invalid message recovery ID." });
        if (body.delivery && !["auto", "queue", "steer"].includes(body.delivery)) return json(res, 400, { error: "Invalid message delivery mode." });
        const result = await bridge.acceptInput(text, attachments, inputId, body.delivery || "auto");
        return json(res, 202, { accepted: true, inputId, ...result });
      }
      if (req.method === "POST" && action === "steer") {
        if (typeof body.inputId !== "string") return json(res, 400, { error: "Missing queued message ID." });
        return json(res, 202, await bridge.steerInput(body.inputId));
      }
      if (req.method === "POST" && action === "remove-queued") {
        await bridge.removeQueuedInput(body.inputId);
        return json(res, 200, { removed: true });
      }
      if (req.method === "POST" && action === "cancel") {
        await bridge.cancelInputs();
        return json(res, 202, { accepted: true });
      }
      if (req.method === "POST" && action === "config") {
        if (!body.configId) return json(res, 400, { error: "Missing setting." });
        const result = await bridge.connection.request("session/set_config_option", {
          sessionId, configId: body.configId, value: body.value
        }, 30_000);
        if (result?.configOptions) bridge.configOptions = result.configOptions;
        return json(res, 200, result || { updated: true });
      }
      if (req.method === "POST" && action === "favorite-model") {
        const modelId = typeof body.modelId === "string" ? body.modelId : "";
        const models = bridge.configOptions.find((option) => option.id === "model")?.options || [];
        if (!models.some((option) => option.value === modelId)) return json(res, 400, { error: "Unknown model." });
        return json(res, 200, await toggleModelFavorite(modelId));
      }
      if (req.method === "POST" && action === "permission") {
        const requestId = String(body.requestId || "");
        if (!bridge.answerPermission(requestId, body.optionId)) return json(res, 404, { error: "Permission request expired." });
        return json(res, 200, { answered: true });
      }
    }
    if (req.method === "GET") return serveStatic(req, res, url.pathname);
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 503, { error: error.message || "Unreal Agent is unavailable." });
  }
});

server.listen(port, host, () => console.log(`Unreal Agent Console is ready at http://${host}:${port}`));

function shutdown() {
  for (const bridge of bridges.values()) bridge.stop();
  commandRunner.stopAll();
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
