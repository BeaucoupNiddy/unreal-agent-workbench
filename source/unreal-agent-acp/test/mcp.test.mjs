import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityBroker, compactWebResult, McpStdioClient } from "../src/mcp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("discovers and invokes an MCP tool on demand", async () => {
  const client = new McpStdioClient({
    name: "mock",
    command: process.execPath,
    args: [path.join(here, "fixtures", "mock-mcp.mjs")],
    env: []
  });
  try {
    const tools = await client.tools();
    assert.equal(tools[0].name, "echo");
    const result = await client.call("echo", { text: "hello" });
    assert.equal(result.content[0].text, "hello");
  } finally {
    client.close();
  }
});

test("caches tool discovery across concurrent and repeated requests", async () => {
  const client = new McpStdioClient({
    name: "mock",
    command: process.execPath,
    args: [path.join(here, "fixtures", "mock-mcp.mjs")],
    env: []
  });
  try {
    const [first, concurrent] = await Promise.all([client.tools(), client.tools()]);
    assert.deepEqual(concurrent, first);
    assert.equal(first[0].description, "Echo a short message (list 1)");
    assert.deepEqual(await client.tools(), first);
    await client.call("echo", { text: "notify-tools-list-changed" });
    const refreshed = await client.tools();
    assert.equal(refreshed[0].description, "Echo a short message (list 2)");
  } finally {
    client.close();
  }
});

test("matches multiword capability queries across tool-name punctuation", async () => {
  const session = {
    id: "search-session",
    mcpServers: [{
      name: "mock",
      command: process.execPath,
      args: [path.join(here, "fixtures", "mock-mcp.mjs")],
      env: []
    }]
  };
  const broker = new CapabilityBroker({ socketPath: "/unused", sessions: new Map([[session.id, session]]) });
  try {
    const tools = await broker.handle({ sessionId: session.id, action: "list", query: "web search" });
    assert.deepEqual(tools.map((tool) => tool.name), ["web_search"]);
  } finally {
    await broker.close();
  }
});

test("forwards optional plans to Zed without a model tool schema", async () => {
  const notifications = [];
  const session = {
    id: "session-1",
    activeClient: { notify: async (method, params) => notifications.push({ method, params }) }
  };
  const broker = new CapabilityBroker({ socketPath: "/unused", sessions: new Map([[session.id, session]]) });
  const result = await broker.handle({
    sessionId: session.id,
    action: "plan",
    entries: [{ content: "Inspect", status: "in_progress" }, { content: "Test", status: "pending", priority: "high" }]
  });
  assert.deepEqual(result, { updated: 2 });
  assert.equal(notifications[0].params.update.sessionUpdate, "plan");
  assert.equal(notifications[0].params.update.entries[1].priority, "high");
});

test("routes project history on demand and blocks it for one-off chats", async () => {
  const projectHistoryRoot = await mkdtemp(path.join(tmpdir(), "ua-empty-history-"));
  const project = { id: "project-session", cwd: "/project", projectHistoryEnabled: true };
  const oneOff = { id: "one-off-session", cwd: "/one-off", projectHistoryEnabled: false };
  const broker = new CapabilityBroker({
    socketPath: "/unused", projectHistoryRoot,
    sessions: new Map([[project.id, project], [oneOff.id, oneOff]])
  });
  assert.equal(await broker.handle({ sessionId: project.id, action: "project_history", query: "prior decision" }), "No relevant chats were found in this project.");
  await assert.rejects(broker.handle({ sessionId: oneOff.id, action: "project_history", query: "prior decision" }), /unavailable for one-off/);
});

test("compacts structured web results without duplicated payloads or broken JSON", () => {
  const result = compactWebResult({
    content: [{ type: "text", text: "a second serialized copy that must be ignored" }],
    structuredContent: { results: [
      { url: "http://www.example.com/page?utm_source=test", title: "Primary", excerpts: ["word ".repeat(1000)] },
      { url: "https://example.com/page", title: "Duplicate", excerpts: ["duplicate"] },
      { url: "https://docs.example.org/guide", title: "Product Guide v2.3 Documentation", excerpts: ["useful"] },
      { url: "https://docs.example.org/guide-old", title: "Product Guide v1.9 Documentation", excerpts: ["older duplicate"] }
    ] }
  });
  assert.equal((result.match(/^\[S\d+\]/gm) || []).length, 3);
  assert.match(result, /^\[S1\] Primary\nhttp:\/\/www\.example\.com\/page\?utm_source=test/m);
  assert.match(result, /Product Guide v2\.3 Documentation/);
  assert.match(result, /Product Guide v1\.9 Documentation/);
  assert.doesNotMatch(result, /second serialized copy|citationGuidance/);
});

test("runs dedicated web search without a discovery action", async () => {
  const session = {
    id: "web-session",
    mcpServers: [{
      name: "mock",
      command: process.execPath,
      args: [path.join(here, "fixtures", "mock-mcp.mjs")],
      env: []
    }]
  };
  const broker = new CapabilityBroker({ socketPath: "/unused", sessions: new Map([[session.id, session]]) });
  try {
    const result = await broker.handle({
      sessionId: session.id,
      action: "web_search",
      objective: "Find official documentation",
      queries: ["official docs"]
    });
    assert.equal((result.match(/^\[S\d+\]/gm) || []).length, 2);
    assert.match(result, /^\[S1\] Primary/m);
  } finally {
    await broker.close();
  }
});

test("runs dedicated web fetch without prompting for permission", async () => {
  const session = {
    id: "fetch-session",
    mcpServers: [{
      name: "mock",
      command: process.execPath,
      args: [path.join(here, "fixtures", "mock-mcp.mjs")],
      env: []
    }]
  };
  const broker = new CapabilityBroker({ socketPath: "/unused", sessions: new Map([[session.id, session]]) });
  try {
    const result = await broker.handle({
      sessionId: session.id,
      action: "web_fetch",
      objective: "Read the relevant evidence",
      urls: ["https://example.com/page"]
    });
    assert.match(result, /^\[S1\] Fetched page/m);
    assert.match(result, /Focused page content/);
  } finally {
    await broker.close();
  }
});

test("shares MCP clients across sessions and caches repeated web searches", async () => {
  const config = { name: "mock", command: process.execPath, args: [path.join(here, "fixtures", "mock-mcp.mjs")], env: [] };
  const first = { id: "first", model: "test-model", mcpServers: [config] };
  const second = { id: "second", model: "test-model", mcpServers: [config] };
  const broker = new CapabilityBroker({ socketPath: "/unused", sessions: new Map([[first.id, first], [second.id, second]]) });
  try {
    assert.equal(broker.clientFor(first, config), broker.clientFor(second, config));
    const request = { action: "web_search", objective: "Find docs", queries: ["docs"] };
    const one = await broker.handle({ ...request, sessionId: first.id });
    const two = await broker.handle({ ...request, sessionId: second.id });
    assert.equal(two, one);
    assert.equal(broker.webCache.size, 1);
  } finally {
    await broker.close();
  }
});

test("rejects malformed socket requests without crashing the broker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ua-cap-test-"));
  const socketPath = path.join(directory, `ua-cap-${process.pid}.sock`);
  const broker = new CapabilityBroker({ socketPath, sessions: new Map() });
  const exchange = (line) => new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("end", () => resolve(JSON.parse(output)));
    socket.on("error", reject);
  });
  try {
    await broker.start();
    assert.deepEqual(await exchange("{bad"), { ok: false, error: "Malformed capability request JSON." });
    assert.deepEqual(await exchange(JSON.stringify({ sessionId: "missing", action: "list" })), {
      ok: false, error: "Unknown capability session."
    });
  } finally {
    await broker.close();
  }
});
