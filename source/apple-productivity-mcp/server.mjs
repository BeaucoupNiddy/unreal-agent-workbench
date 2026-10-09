#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(root, "native-bridge.jxa");
const calendarHelperPath = process.env.UNREAL_CALENDAR_HELPER || path.join(
  process.env.HOME || "",
  "Applications", "Unreal Agent.app", "Contents", "MacOS", "UnrealAgentCalendar"
);
const capabilities = new Set(String(process.env.APPLE_MCP_CAPABILITIES || "notes,calendar").split(",").map((item) => item.trim()).filter(Boolean));

export function availableTools(enabled = capabilities) {
  const tools = [];
  if (enabled.has("notes")) tools.push(
    { name: "notes_search", description: "Search Apple Notes by title or body text. Returns compact previews and stable note IDs.", inputSchema: { type: "object", properties: { query: { type: "string" }, folder: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
    { name: "notes_get", description: "Read the full plain-text body of one Apple Note by ID.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
    { name: "notes_create", description: "Create an Apple Note. This changes the user's Notes library and requires approval.", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, folder: { type: "string" } }, required: ["title"], additionalProperties: false } }
  );
  if (enabled.has("calendar")) tools.push(
    { name: "calendar_list", description: "List Apple Calendar calendars and whether each is writable.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "calendar_today", description: "List today's Apple Calendar events using the Mac's local timezone. Use this directly for requests about today.", inputSchema: { type: "object", properties: { query: { type: "string" }, calendar: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } },
    { name: "calendar_search", description: "Find Apple Calendar events in a date range, optionally filtered by calendar or text.", inputSchema: { type: "object", properties: { start: { type: "string", description: "ISO-8601 date/time; defaults to now." }, end: { type: "string", description: "ISO-8601 date/time; defaults to 30 days from now." }, query: { type: "string" }, calendar: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } },
    { name: "calendar_create", description: "Create an Apple Calendar event. This changes the user's calendar and requires approval.", inputSchema: { type: "object", properties: { calendar: { type: "string" }, title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, allDay: { type: "boolean" }, location: { type: "string" }, notes: { type: "string" } }, required: ["title", "start", "end"], additionalProperties: false } }
  );
  return tools.map((tool) => ({ ...tool, annotations: {
    readOnlyHint: !["notes_create", "calendar_create"].includes(tool.name),
    destructiveHint: false,
    idempotentHint: !["notes_create", "calendar_create"].includes(tool.name)
  } }));
}

const nativeActions = {
  notes_search: "notesSearch",
  notes_get: "notesGet",
  notes_create: "notesCreate",
  calendar_list: "calendarList",
  calendar_today: "calendarToday",
  calendar_search: "calendarSearch",
  calendar_create: "calendarCreate"
};

async function callNative(toolName, args, { signal } = {}) {
  if (process.platform !== "darwin") throw new Error("Apple Notes and Calendar capabilities require macOS.");
  const action = nativeActions[toolName];
  if (!action || !availableTools().some((tool) => tool.name === toolName)) throw new Error(`Unknown or disabled tool: ${toolName}`);
  try {
    const isCalendarAction = toolName.startsWith("calendar_");
    const command = isCalendarAction ? calendarHelperPath : "/usr/bin/osascript";
    const commandArgs = isCalendarAction
      ? [action, JSON.stringify(args || {})]
      : ["-l", "JavaScript", bridgePath, action, JSON.stringify(args || {})];
    const { stdout } = await execFileAsync(command, commandArgs, {
      signal,
      timeout: isCalendarAction ? 125_000 : 12_000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024
    });
    return JSON.parse(stdout.trim() || "{}");
  } catch (error) {
    if (signal?.aborted || error?.code === "ABORT_ERR") throw new Error("Apple tool was cancelled. A change already accepted by Notes or Calendar may still finish.");
    if (error?.killed || error?.code === "ETIMEDOUT") {
      throw new Error("Apple access timed out. Keep the Mac unlocked and respond to the macOS authorization prompt, then try again.");
    }
    if (error?.code === "ENOENT" && toolName.startsWith("calendar_")) {
      throw new Error("The Unreal Agent Calendar helper is not installed. Run apple-productivity-mcp/build-calendar-helper.sh, then try again.");
    }
    throw error;
  }
}

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function success(id, result) { send({ jsonrpc: "2.0", id, result }); }
function failure(id, error) { send({ jsonrpc: "2.0", id, error: { code: -32000, message: error?.message || String(error) } }); }

const activeRequests = new Map();
export async function handleMessage(message, invoke = callNative, requests = activeRequests) {
  if (message.method === "notifications/cancelled") {
    requests.get(message.params?.requestId)?.abort();
    return undefined;
  }
  if (message.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "apple-productivity", version: "0.1.0" } };
  if (message.method === "tools/list") return { tools: availableTools() };
  if (message.method === "tools/call") {
    const controller = new AbortController();
    if (message.id !== undefined) {
      if (requests.has(message.id)) throw new Error("Duplicate active request ID.");
      requests.set(message.id, controller);
    }
    try {
      const data = await invoke(message.params?.name, message.params?.arguments || {}, { signal: controller.signal });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
    } finally { if (requests.get(message.id) === controller) requests.delete(message.id); }
  }
  if (message.method?.startsWith("notifications/")) return undefined;
  throw new Error(`Unsupported MCP method: ${message.method}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("close", () => { for (const controller of activeRequests.values()) controller.abort(); });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch (error) { failure(null, new Error("Malformed JSON-RPC message.")); return; }
    try {
      const result = await handleMessage(message);
      if (message.id !== undefined && result !== undefined) success(message.id, result);
    } catch (error) {
      if (message.id !== undefined) failure(message.id, error);
    }
  });
}
