import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { packageVersion } from "./version.mjs";
import { searchProjectHistory } from "./project-history.mjs";
import { BrowserManager } from "./browser.mjs";
import { addToolApproval, readToolApprovals, toolApprovalsFileName } from "./tool-approvals.mjs";

const webCacheMaxAgeMs = 10 * 60 * 1000;
const maximumCachedWebQueries = 100;

function envObject(entries = []) {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
}

function boundedResult(value) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 20000) return value;
  return { truncated: true, preview: serialized.slice(0, 20000), note: "Capability output was limited to preserve model context." };
}

function truncateAtBoundary(value, maximum) {
  const text = String(value || "").trim();
  if (text.length <= maximum) return text;
  const prefix = text.slice(0, maximum - 1);
  const boundary = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf(" "));
  return `${prefix.slice(0, boundary > maximum * 0.7 ? boundary : prefix.length).trimEnd()}…`;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    // This URL is only a comparison key; callers retain the original URL for display.
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

function nearDuplicateKey(result, url) {
  const title = String(result?.title || "").toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, " ").trim();
  if (title.length < 12) return "";
  try {
    const parsed = new URL(url);
    const withoutVersion = title.replace(/\bv?\d+(?:\.\d+){1,3}\b/g, " ").replace(/\s+/g, " ").trim();
    const hasVersion = withoutVersion !== title;
    return hasVersion
      ? `${parsed.hostname}|${parsed.pathname}|${withoutVersion}`
      : `${parsed.hostname}|${title}`;
  }
  catch { return ""; }
}

function structuredPayload(value) {
  if (value?.structuredContent && typeof value.structuredContent === "object") return value.structuredContent;
  const text = value?.content?.find?.((item) => item?.type === "text")?.text;
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return {}; }
}

export function compactWebResult(value, { kind = "search", maxResults = 8, maxCharsPerResult = 1400 } = {}) {
  const payload = structuredPayload(value);
  const sources = [];
  const seen = new Set();
  const seenNearDuplicates = new Set();
  for (const result of Array.isArray(payload.results) ? payload.results : []) {
    if (!result?.url) continue;
    const displayUrl = String(result.url).trim();
    const canonical = canonicalUrl(displayUrl);
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    const nearKey = nearDuplicateKey(result, canonical);
    if (nearKey && seenNearDuplicates.has(nearKey)) continue;
    seen.add(key);
    if (nearKey) seenNearDuplicates.add(nearKey);
    const rawText = kind === "fetch" && result.full_content
      ? result.full_content
      : (Array.isArray(result.excerpts) ? result.excerpts.join("\n\n") : result.excerpt || "");
    sources.push({
      id: `S${sources.length + 1}`,
      title: String(result.title || displayUrl).trim(),
      url: displayUrl,
      ...(result.publish_date ? { published: result.publish_date } : {}),
      content: truncateAtBoundary(rawText, maxCharsPerResult)
    });
    if (sources.length >= maxResults) break;
  }
  const warnings = (Array.isArray(payload.warnings) ? payload.warnings : [])
    .map((warning) => String(warning?.message || warning || "").trim()).filter(Boolean).slice(0, 3);
  const errors = (Array.isArray(payload.errors) ? payload.errors : [])
    .map((error) => ({ url: error?.url, error: error?.error_type || "fetch_failed", status: error?.http_status_code ?? undefined }))
    .slice(0, 5);
  const sections = sources.map((source) => [
    `[${source.id}] ${source.title}`,
    source.url,
    ...(source.published ? [`Published: ${source.published}`] : []),
    source.content
  ].filter(Boolean).join("\n"));
  if (warnings.length) sections.push(`Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`);
  if (errors.length) sections.push(`Errors:\n${errors.map((error) => `- ${error.url || "Source"}: ${error.error}${error.status ? ` (${error.status})` : ""}`).join("\n")}`);
  return sections.join("\n\n");
}

const maximumConcurrentServerListings = 3;

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export class McpStdioClient {
  constructor(config) {
    this.config = config;
    this.child = null;
    this.startPromise = null;
    this.toolsPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.stderr = "";
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.child) return;
    const child = spawn(this.config.command, this.config.args || [], {
      env: { ...process.env, ...envObject(this.config.env) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8000); });
    child.once("exit", (code) => {
      const error = new Error(this.stderr || `MCP server ${this.config.name} exited with status ${code}.`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (this.child === child) {
        this.child = null;
        this.toolsPromise = null;
      }
    });
    child.once("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (this.child === child) {
        this.child = null;
        this.toolsPromise = null;
      }
    });

    const startPromise = this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "unreal-agent-acp", version: packageVersion }
    }).then(() => {
      if (this.child !== child) throw new Error(`MCP server ${this.config.name} exited during initialization.`);
      this.notify("notifications/initialized", {});
    }).catch((error) => {
      if (this.child === child) {
        this.child = null;
        child.kill("SIGTERM");
      }
      this.toolsPromise = null;
      throw error;
    }).finally(() => {
      if (this.startPromise === startPromise) this.startPromise = null;
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  consume(chunk) {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { continue; }
      if (message.method === "notifications/tools/list_changed") {
        this.toolsPromise = null;
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  request(method, params = {}, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(new Error("External tool request was cancelled."));
    if (!this.child?.stdin?.writable) return Promise.reject(new Error(`MCP server ${this.config.name} is not running.`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        try { this.notify("notifications/cancelled", { requestId: id, reason: "Task cancelled" }); } catch {}
        this.pending.get(id)?.reject(new Error("External tool cancellation requested; the service may still complete work it already accepted."));
      };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id); };
      const timer = setTimeout(() => {
        try { this.notify("notifications/cancelled", { requestId: id, reason: "Request timed out" }); } catch {}
        this.pending.get(id)?.reject(new Error(`MCP server ${this.config.name} timed out handling ${method}; cancellation was requested, but accepted external work may still finish.`));
      }, 60000);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); }
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
      catch (error) { this.pending.get(id)?.reject(error); }
    });
  }

  notify(method, params = {}) {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async tools() {
    await this.start();
    if (!this.toolsPromise) {
      const toolsPromise = this.request("tools/list", {}).then((result) => result?.tools || []).catch((error) => {
        if (this.toolsPromise === toolsPromise) this.toolsPromise = null;
        throw error;
      });
      this.toolsPromise = toolsPromise;
    }
    return this.toolsPromise;
  }

  async call(name, args, options = {}) {
    await this.start();
    return this.request("tools/call", { name, arguments: args || {} }, options);
  }

  close() {
    this.child?.kill("SIGTERM");
    this.child = null;
    this.toolsPromise = null;
  }
}

export class CapabilityBroker {
  constructor({ socketPath, sessions, legacySocketDirectory, projectHistoryRoot, projectMemoryRoot, generationSettingsFile, requestFolderAccess, delegate, swarm, listAgents, browser, dataDir }) {
    this.socketPath = socketPath;
    this.sessions = sessions;
    this.legacySocketDirectory = legacySocketDirectory;
    this.projectHistoryRoot = projectHistoryRoot;
    this.projectMemoryRoot = projectMemoryRoot;
    this.generationSettingsFile = generationSettingsFile;
    this.requestFolderAccess = requestFolderAccess;
    this.delegate = delegate;
    this.swarm = swarm;
    this.listAgents = listAgents;
    this.browser = browser || (dataDir ? new BrowserManager({ dataDir }) : null);
    this.toolApprovalsFile = dataDir ? path.join(dataDir, toolApprovalsFileName) : null;
    this.server = null;
    this.clients = new Map();
    this.webCache = new Map();
  }

  async start() {
    if (this.server) return;
    await this.removeStaleSockets(path.dirname(this.socketPath), path.basename(this.socketPath).replace(/\d+\.sock$/, ""));
    if (this.legacySocketDirectory) await this.removeStaleSockets(this.legacySocketDirectory, "capabilities-");
    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.server = net.createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString("utf8");
        while (input.includes("\n")) {
          const newline = input.indexOf("\n");
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          if (!line.trim()) continue;
          let request;
          try { request = JSON.parse(line); }
          catch {
            socket.end(`${JSON.stringify({ ok: false, error: "Malformed capability request JSON." })}\n`);
            return;
          }
          this.handle(request).then(
            (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
            (error) => socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`)
          );
          return;
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    }).catch((error) => {
      this.server = null;
      throw error;
    });
    this.server.unref();
  }

  async removeStaleSockets(directory, prefix) {
    const entries = await fs.readdir(directory).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".sock")).map(async (entry) => {
      const match = entry.match(/(\d+)\.sock$/);
      if (!match || Number(match[1]) === process.pid) return;
      try { process.kill(Number(match[1]), 0); }
      catch (error) {
        if (error.code === "ESRCH") await fs.unlink(path.join(directory, entry)).catch(() => {});
      }
    }));
  }

  configKey(config) {
    return JSON.stringify([config.name, config.command, config.args || [], config.env || []]);
  }

  clientFor(session, config) {
    const key = this.configKey(config);
    if (!this.clients.has(key)) this.clients.set(key, new McpStdioClient(config));
    return this.clients.get(key);
  }

  warm(session) {
    const server = (session.mcpServers || []).find((candidate) => /parallel|search|web/i.test(candidate.name));
    if (server) this.clientFor(session, server).tools().catch(() => {});
  }

  cachedWebResult(key, load) {
    const now = Date.now();
    const cached = this.webCache.get(key);
    if (cached && now - cached.createdAt < webCacheMaxAgeMs) return cached.promise;
    const promise = Promise.resolve().then(load).catch((error) => {
      this.webCache.delete(key);
      throw error;
    });
    this.webCache.set(key, { createdAt: now, promise });
    while (this.webCache.size > maximumCachedWebQueries) this.webCache.delete(this.webCache.keys().next().value);
    return promise;
  }

  async resolveTool(session, servers, toolName) {
    const preferred = [...servers].sort((left, right) => {
      const leftPreferred = /parallel|search|web/i.test(left.name) ? 1 : 0;
      const rightPreferred = /parallel|search|web/i.test(right.name) ? 1 : 0;
      return rightPreferred - leftPreferred;
    });
    for (const server of preferred) {
      const tools = await this.clientFor(session, server).tools();
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (tool) return { server, tool };
    }
    throw new Error(`No MCP server provides ${toolName}.`);
  }

  async requestToolPermission(session, server, tool, argumentsValue) {
    const approvalKey = `${server.name}/${tool.name}`;
    if (session.approvedCapabilities?.has(approvalKey)) return;
    if (this.toolApprovalsFile && (await readToolApprovals(this.toolApprovalsFile).catch(() => [])).includes(approvalKey)) return;
    if (!session.activeClient) throw new Error("Unreal tool approval is unavailable: open this chat in Unreal Agent Console or Zed, then ask to try again. The tool has not run; this is not a macOS privacy denial.");
    const toolCallId = `mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let response;
    try {
      response = await session.activeClient.request("session/request_permission", {
        sessionId: session.id,
        toolCall: {
          toolCallId,
          title: `Use ${server.name}: ${tool.name}`,
          kind: "other",
          status: "pending",
          rawInput: argumentsValue || {}
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow for this session", kind: "allow_always" },
          ...(this.toolApprovalsFile ? [{ optionId: "allow-forever", name: "Always allow", kind: "allow_always" }] : []),
          { optionId: "reject", name: "Reject", kind: "reject_once" }
        ]
      });
    } catch (error) {
      if (/no clients attached|connection closed|request_permission.*timed out/i.test(error?.message || "")) {
        throw new Error("Unreal tool approval could not reach a connected client. Reopen this chat in Unreal Agent Console or Zed, keep it connected, and ask to try again. The tool has not run; this is not a macOS Calendar/Notes permission failure. Do not reset macOS privacy permissions.", { cause: error });
      }
      throw error;
    }
    const selected = response?.outcome?.optionId;
    if (response?.outcome?.outcome !== "selected" || !selected?.startsWith("allow")) throw new Error("The MCP tool call was not approved.");
    if (selected === "allow-always" || selected === "allow-forever") {
      session.approvedCapabilities ||= new Set();
      session.approvedCapabilities.add(approvalKey);
    }
    // Saving is best effort: the approval already applies to this chat.
    if (selected === "allow-forever") await addToolApproval(this.toolApprovalsFile, approvalKey).catch(() => {});
  }

  async invokeTool(session, server, tool, argumentsValue, { skipPermission = false } = {}) {
    if (session.activeTurn?.cancelled || session.cancelled) throw new Error("The task was cancelled; this tool has not run.");
    if (session.permissionMode === "read-only" && tool.annotations?.readOnlyHint !== true && !["web_search", "web_fetch"].includes(tool.name)) {
      throw new Error("Read-only mode blocks external tools without an explicit read-only declaration. Change Permissions to Workspace before using this tool.");
    }
    const generation = session.capabilityGeneration || 0;
    if (!skipPermission) await this.requestToolPermission(session, server, tool, argumentsValue);
    if (generation !== (session.capabilityGeneration || 0) || session.activeTurn?.cancelled || session.cancelled) throw new Error("The task was cancelled while awaiting approval; this tool has not run.");
    const controller = new AbortController();
    session.activeCapabilities ||= new Set();
    const call = { controller, server: server.name, tool: tool.name };
    session.activeCapabilities.add(call);
    try {
      return await this.clientFor(session, server).call(tool.name, argumentsValue || {}, { signal: controller.signal });
    } finally { session.activeCapabilities.delete(call); }
  }

  async handle(request) {
    const session = this.sessions.get(request.sessionId);
    if (!session) throw new Error("Unknown capability session.");
    if (session.isSubagent && ["request_write", "plan", "delegate", "agents", "swarm"].includes(request.action)) {
      throw new Error(request.action === "request_write"
        ? "Subagents cannot request folder access. Report the folder you need to the primary agent instead."
        : "This capability is only available to the primary agent.");
    }
    if (request.action === "swarm") {
      if (!this.swarm) throw new Error("Swarms are unavailable in this broker.");
      return this.swarm(session, request);
    }
    if (request.action === "swarm_send" || request.action === "swarm_inbox") {
      if (!session.swarm) throw new Error("Only swarm members can use swarm messages.");
      return request.action === "swarm_send"
        ? session.swarm.send(session.swarmMember, { to: request.to, message: request.message })
        : session.swarm.drain(session.swarmMember);
    }
    if (request.action === "browser") {
      if (!this.browser) throw new Error("The browser is unavailable in this broker.");
      if (session.activeTurn?.cancelled || session.cancelled) throw new Error("The task was cancelled; the browser step has not run.");
      const notify = (text) => Promise.resolve(session.activeClient?.notify?.("session/update", { sessionId: session.id, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text } } })).catch(() => {});
      return this.browser.run(session, request.arguments || {}, { notify });
    }
    if (request.action === "delegate") {
      if (!this.delegate) throw new Error("Subagents are unavailable in this broker.");
      return this.delegate(session, request);
    }
    if (request.action === "agents") {
      if (!this.listAgents) throw new Error("Subagents are unavailable in this broker.");
      return this.listAgents(session);
    }
    if (request.action === "request_write") {
      if (!this.requestFolderAccess) throw new Error("Folder approval is unavailable in this broker.");
      return this.requestFolderAccess(session, request);
    }
    if (request.action === "plan") {
      if (!session.activeClient) throw new Error("Plans can only be updated during an active Zed turn.");
      const allowedStatuses = new Set(["pending", "in_progress", "completed"]);
      const entries = (Array.isArray(request.entries) ? request.entries : []).slice(0, 20).map((entry) => ({
        content: String(entry.content || "").slice(0, 500),
        status: allowedStatuses.has(entry.status) ? entry.status : "pending",
        priority: ["low", "medium", "high"].includes(entry.priority) ? entry.priority : "medium"
      })).filter((entry) => entry.content);
      if (!entries.length) throw new Error("A plan requires at least one entry.");
      await session.activeClient.notify("session/update", {
        sessionId: session.id,
        update: { sessionUpdate: "plan", entries }
      });
      return { updated: entries.length };
    }
    if (request.action === "project_history") {
      if (session.projectHistoryEnabled === false) throw new Error("Project history is unavailable for chats without a project.");
      if (this.generationSettingsFile) {
        const settings = await fs.readFile(this.generationSettingsFile, "utf8").then(JSON.parse).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (settings?.memoryEnabled === false) throw new Error("Project memory is turned off in Settings.");
      }
      const query = String(request.query || "").trim().slice(0, 300);
      if (!query) throw new Error("Project history search requires a query.");
      return searchProjectHistory({
        sessionRoot: this.projectHistoryRoot,
        memoryRoot: this.projectMemoryRoot,
        cwd: session.cwd,
        currentUpstreamSessionId: session.id,
        query,
        maxResults: request.maxResults,
        maxCharsPerResult: request.maxCharsPerResult
      });
    }
    const servers = (session.mcpServers || []).filter((server) => !server.type || server.type === "stdio");
    if (request.action === "web_search") {
      const objective = String(request.objective || "").trim().slice(0, 500);
      const queries = (Array.isArray(request.queries) ? request.queries : [])
        .map((query) => String(query || "").trim().slice(0, 200)).filter(Boolean).slice(0, 4);
      if (!objective || !queries.length) throw new Error("Web search requires an objective and 1-4 queries.");
      const maxResults = Math.max(1, Math.min(8, Number(request.maxResults) || 8));
      const maxCharsPerResult = Math.max(200, Math.min(5000, Number(request.maxCharsPerResult) || 1400));
      const { server, tool } = await this.resolveTool(session, servers, "web_search");
      const cacheKey = JSON.stringify([this.configKey(server), session.model, objective, queries, maxResults, maxCharsPerResult]);
      return this.cachedWebResult(cacheKey, async () => {
        const result = await this.invokeTool(session, server, tool, {
          objective,
          search_queries: queries,
          model_name: session.model,
          session_id: session.id.slice(0, 100)
        }, { skipPermission: true });
        return compactWebResult(result, { kind: "search", maxResults, maxCharsPerResult });
      });
    }
    if (request.action === "web_fetch") {
      const urls = (Array.isArray(request.urls) ? request.urls : [])
        .map((url) => String(url || "").trim()).filter((url) => /^https?:\/\//i.test(url)).slice(0, 3);
      if (!urls.length) throw new Error("Web fetch requires 1-3 HTTP(S) URLs.");
      const objective = String(request.objective || "Read the source for relevant evidence.").trim().slice(0, 200);
      const queries = (Array.isArray(request.queries) ? request.queries : [])
        .map((query) => String(query || "").trim().slice(0, 200)).filter(Boolean).slice(0, 4);
      const { server, tool } = await this.resolveTool(session, servers, "web_fetch");
      const result = await this.invokeTool(session, server, tool, {
        urls,
        objective,
        ...(queries.length ? { search_queries: queries } : {}),
        full_content: false,
        allow_live_fetch: true,
        session_id: session.id.slice(0, 100)
      }, { skipPermission: true });
      return compactWebResult(result, { kind: "fetch", maxResults: 3, maxCharsPerResult: 5000 });
    }
    if (request.action === "list") {
      const queryTerms = normalizeSearchText(request.query).split(/\s+/).filter(Boolean);
      const found = [];
      const query = normalizeSearchText(request.query);
      const exact = servers.filter((server) => query === normalizeSearchText(server.name));
      const named = exact.length ? exact : servers.filter((server) => query.startsWith(`${normalizeSearchText(server.name)} `));
      const selected = named.length ? named : servers;
      for (let offset = 0; offset < selected.length; offset += maximumConcurrentServerListings) {
        const batch = selected.slice(offset, offset + maximumConcurrentServerListings);
        const catalogs = await Promise.allSettled(batch.map(async (server) => ({
          server,
          tools: await this.clientFor(session, server).tools()
        })));
        for (const result of catalogs) {
          if (result.status !== "fulfilled") continue;
          const { server, tools } = result.value;
          for (const tool of tools) {
            const candidate = normalizeSearchText(`${server.name} ${tool.name} ${tool.description || ""}`);
            if (queryTerms.length && !queryTerms.every((term) => candidate.includes(term))) continue;
            const entry = {
              server: server.name,
              name: tool.name,
              description: String(tool.description || "").slice(0, 500),
              ...(Buffer.byteLength(JSON.stringify(tool.inputSchema || {})) < 3000 ? { inputSchema: tool.inputSchema } : { schemaAvailable: true, note: "Use unreal-capability schema <server> <tool> for the full schema." })
            };
            if (Buffer.byteLength(JSON.stringify([...found, entry])) > 16_000) return found;
            found.push(entry);
            if (found.length >= 30) return found;
          }
        }
      }
      return found;
    }
    if (request.action === "call" || request.action === "schema") {
      const server = servers.find((candidate) => candidate.name === request.server);
      if (!server) throw new Error(`Unknown MCP server: ${request.server}`);
      const tools = await this.clientFor(session, server).tools();
      const tool = tools.find((candidate) => candidate.name === request.tool);
      if (!tool) throw new Error(`Unknown MCP tool: ${request.server}/${request.tool}`);
      if (request.action === "schema") return { server: server.name, name: tool.name, inputSchema: tool.inputSchema };
      const result = await this.invokeTool(session, server, tool, request.arguments || {});
      if (tool.name === "web_search") return compactWebResult(result, { kind: "search" });
      if (tool.name === "web_fetch") return compactWebResult(result, { kind: "fetch", maxResults: 3, maxCharsPerResult: 5000 });
      return boundedResult(result);
    }
    throw new Error(`Unknown capability action: ${request.action}`);
  }

  closeSession(session) {
    this.cancelSession(session);
    // Processes are shared, but their individual requests belong to a task.
    // Each chat or subagent has its own browser context, closed with it.
    void this.browser?.closeSession(session.id);
  }

  cancelSession(session) {
    session.capabilityGeneration = (session.capabilityGeneration || 0) + 1;
    for (const call of session.activeCapabilities || []) {
      call.controller.abort();
      void Promise.resolve(session.activeClient?.notify?.("session/update", { sessionId: session.id, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Cancellation requested for ${call.server}/${call.tool}. The external service may still finish work it already accepted; verify its result before retrying.` }
      } })).catch(() => {});
    }
  }

  async close() {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    await this.browser?.close();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    await fs.unlink(this.socketPath).catch(() => {});
  }
}
