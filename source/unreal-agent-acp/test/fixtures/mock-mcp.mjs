#!/usr/bin/env node
import readline from "node:readline";

let toolsListCount = 0;
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") {
    result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } };
  } else if (message.method === "tools/list") {
    toolsListCount += 1;
    result = { tools: [
      { name: "echo", description: `Echo a short message (list ${toolsListCount})`, inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "web_search", description: "Search the web for current facts", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "web_fetch", description: "Fetch a web page", inputSchema: { type: "object", properties: { urls: { type: "array" } } } }
    ] };
  } else if (message.method === "tools/call") {
    if (message.params.arguments.text === "notify-tools-list-changed") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`);
    }
    if (message.params.name === "web_search") {
      result = { content: [{ type: "text", text: "duplicate text payload" }], structuredContent: { results: [
        { url: "http://www.example.com/page?utm_source=test", title: "Primary", publish_date: "2026-01-01", excerpts: ["Useful evidence ".repeat(200)] },
        { url: "https://example.com/page", title: "Duplicate", excerpts: ["duplicate"] },
        { url: "https://docs.example.org/guide", title: "Guide", excerpts: ["Documentation"] }
      ] } };
    } else if (message.params.name === "web_fetch") {
      result = { structuredContent: { results: [
        { url: message.params.arguments.urls[0], title: "Fetched page", excerpts: ["Focused page content"] }
      ], errors: [] } };
    } else {
      result = { content: [{ type: "text", text: message.params.arguments.text }] };
    }
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
