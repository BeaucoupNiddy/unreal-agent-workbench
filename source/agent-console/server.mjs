import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { configuredMcpServers, readMcpSettings, saveMcpSettings } from "./mcp-settings.mjs";
import { assertManagedHydra, hydraServiceLabel } from "./hydra-service.mjs";
import { AutoTitleScheduler } from "./auto-title.mjs";
import { BackgroundGenerator } from "./background-generation.mjs";
import { generationModels, readGenerationSettings, saveGenerationSettings } from "./generation-settings.mjs";

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
const projectMemoryDir = path.join(appDataDir, "project-memories");
const agentDataDir = path.join(homedir(), "Library", "Application Support", "Unreal Agent ACP");
const modelFavoritesFile = path.join(agentDataDir, "model-favorites.json");
const hydraCli = path.join(root, "..", "hydra-gateway", "node_modules", ".bin", "hydra-acp");
const appleMcpServer = path.join(root, "..", "apple-productivity-mcp", "server.mjs");
const runner = process.env.UNREAL_AGENT_RUNNER || path.join(homedir(), ".local", "bin", "unreal-agent-runner");
const execFileAsync = promisify(execFile);
const bridges = new Map();
let hydraStart = null;
let favoriteUpdate = Promise.resolve();
const backgroundGenerator = new BackgroundGenerator({
  hydraSessionRoot: path.join(hydraDir, "sessions"),
  memoryRoot: projectMemoryDir,
  oneOffWorkspace: oneOffWorkspaceDir,
  runner,
  readSettings: () => readGenerationSettings(generationSettingsFile),
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
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }
  respond(id, result) { this.send({ jsonrpc: "2.0", id, result }); }
  reject(id, code, message) { this.send({ jsonrpc: "2.0", id, error: { code, message } }); }
  close() { this.socket?.close(); }
}

class SessionBridge {
  constructor(sessionId, response) {
    this.sessionId = sessionId;
    this.response = response;
    this.connection = new HydraConnection();
    this.permissionRequests = new Map();
    this.heartbeat = null;
    this.configOptions = [];
  }

  emit(type, payload = {}) {
    if (!this.response.destroyed) this.response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  async start() {
    await this.connection.connect();
    this.connection.onNotification = (message) => this.emit("hydra", message);
    this.connection.onRequest = (message) => {
      if (message.method === "session/request_permission") {
        this.permissionRequests.set(String(message.id), message.id);
        this.emit("permission", { requestId: String(message.id), ...message.params });
      } else {
        this.connection.reject(message.id, -32601, "This console does not provide filesystem or terminal access.");
      }
    };
    const result = await this.connection.request("session/attach", {
      sessionId: this.sessionId,
      historyPolicy: "full",
      _meta: { "hydra-acp": { historyLimit: 0 } },
      clientInfo: { name: "unreal-agent-console", title: "Unreal Agent Console", version: "0.1.0" }
    }, 30_000);
    this.configOptions = result?.configOptions || [];
    this.emit("ready", { ...(result || {}), modelFavorites: await readModelFavorites() });
    this.heartbeat = setInterval(() => this.response.write(": heartbeat\n\n"), 20_000);
  }

  async prompt(text, attachments = []) {
    this.emit("console", { kind: "prompt_started", text });
    try {
      const result = await this.connection.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [...(text ? [{ type: "text", text }] : []), ...attachments.map(({ mimeType, data }) => ({ type: "image", mimeType, data }))]
      }, 900_000);
      this.emit("console", { kind: "prompt_complete", result });
      void autoTitles.afterPrompt(this.sessionId).then((handledTitle) => {
        if (!handledTitle) return backgroundGenerator.afterPrompt(this.sessionId);
      }).catch((error) => {
        console.warn(`Background generation failed for ${this.sessionId}: ${error.message}`);
      });
    } catch (error) {
      this.emit("console", { kind: "prompt_error", error: error.message });
    }
  }

  stop() {
    clearInterval(this.heartbeat);
    this.connection.close();
    if (bridges.get(this.sessionId) === this) bridges.delete(this.sessionId);
  }
}

async function createSession(body) {
  const connection = await new HydraConnection().connect();
  try {
    const mcpSettings = await readMcpSettings(mcpSettingsFile);
    const result = await connection.request("session/new", {
      cwd: body.cwd,
      mcpServers: configuredMcpServers(mcpSettings, { nodePath: process.execPath, appleServerPath: appleMcpServer }),
      _meta: {
        "hydra-acp": { agentId: "unreal", ...(body.title ? { title: body.title } : {}) },
        "unreal-agent": { projectHistory: body.oneOff !== true }
      }
    }, 30_000);
    if (!body.title) autoTitles.track(result?.sessionId);
    return result;
  } finally {
    connection.close();
  }
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
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(events|prompt|cancel|config|favorite-model|permission))?$/);

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
      return json(res, 200, { settings: await readMcpSettings(mcpSettingsFile), appliesTo: "new-chats" });
    }
    if (req.method === "PUT" && url.pathname === "/api/capabilities") {
      const settings = await saveMcpSettings(mcpSettingsFile, await readJson(req));
      return json(res, 200, { settings, appliesTo: "new-chats" });
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
    if (req.method === "GET" && url.pathname === "/api/status") {
      const health = await hydraJson("/v1/health");
      return json(res, 200, { ready: true, health });
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return json(res, 200, await listSessions());
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
    if (match) {
      const sessionId = safeSessionId(decodeURIComponent(match[1]));
      const action = match[2];
      if (!sessionId) return json(res, 400, { error: "Invalid session." });
      if (req.method === "GET" && action === "events") {
        bridges.get(sessionId)?.stop();
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
          connection: "keep-alive", "x-accel-buffering": "no"
        });
        res.write("retry: 2000\n\n");
        const bridge = new SessionBridge(sessionId, res);
        bridges.set(sessionId, bridge);
        req.on("close", () => bridge.stop());
        try { await bridge.start(); }
        catch (error) { bridge.emit("fault", { error: error.message }); bridge.stop(); }
        return;
      }
      if (req.method === "DELETE" && !action) {
        await hydraJson(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", timeoutMs: 30_000 });
        const bridge = bridges.get(sessionId);
        if (bridge) {
          bridge.stop();
          if (!bridge.response.destroyed && !bridge.response.writableEnded) bridge.response.end();
        }
        return json(res, 200, { deleted: true });
      }
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
        void bridge.prompt(text, attachments);
        return json(res, 202, { accepted: true });
      }
      if (req.method === "POST" && action === "cancel") {
        bridge.connection.notify("session/cancel", { sessionId });
        return json(res, 202, { accepted: true });
      }
      if (req.method === "POST" && action === "config") {
        if (!body.configId) return json(res, 400, { error: "Missing setting." });
        const result = await bridge.connection.request("session/set_config_option", {
          sessionId, configId: body.configId, value: body.value
        }, 30_000);
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
        const wireId = bridge.permissionRequests.get(requestId);
        if (wireId === undefined) return json(res, 404, { error: "Permission request expired." });
        bridge.permissionRequests.delete(requestId);
        bridge.connection.respond(wireId, { outcome: { outcome: "selected", optionId: body.optionId } });
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
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
