#!/usr/bin/env node
import net from "node:net";

const [action, firstArgument, second, thirdArgument] = process.argv.slice(2);
const usage = "Usage:\n  unreal-capability request-write '{\"folders\":[\"~/specific/folder\"],\"reason\":\"why write access is needed\"}'\n  unreal-capability project-history '{\"query\":\"prior decision or topic\"}'\n  unreal-capability web-search '{\"objective\":\"...\",\"queries\":[\"...\"]}'\n  unreal-capability web-fetch '{\"urls\":[\"https://...\"],\"objective\":\"...\"}'\n  unreal-capability list [query]\n  unreal-capability schema <server> <tool>\n  unreal-capability call <server> <tool> '<json>'\n  unreal-capability plan '[{\"content\":\"step\",\"status\":\"pending|in_progress|completed\"}]'\n  unreal-capability agents\n  unreal-capability delegate '{\"agent\":\"id\",\"task\":\"complete instructions\"}'\n  unreal-capability swarm '{\"task\":\"the problem\",\"agents\":[\"id\",\"id\"]}'\n  unreal-capability swarm-send '{\"to\":\"all\",\"message\":\"...\"}'\n  unreal-capability swarm-inbox\n  unreal-capability browser '{\"action\":\"open\",\"url\":\"http://localhost:3000\"}'\n    actions: open snapshot click type press select hover wait scroll back forward reload\n             screenshot console network eval tabs viewport close";
let first = firstArgument;
let third = thirdArgument;
if (!process.stdin.isTTY && ((["web-search", "web_search", "web-fetch", "web_fetch", "project-history", "project_history", "request-write", "plan", "delegate", "swarm", "swarm-send", "browser"].includes(action) && !first)
  || (action === "call" && !third))) {
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk.toString("utf8");
  if (["web-search", "web_search", "web-fetch", "web_fetch", "project-history", "project_history", "request-write", "plan", "delegate", "swarm", "swarm-send", "browser"].includes(action) && !first) first = stdin.trim();
  else if (action === "call" && !third) third = stdin.trim();
}
if (["--help", "-h", "help"].includes(firstArgument) || ["--help", "-h", "help", undefined].includes(action)) {
  console.log(usage);
  process.exit(0);
}
const socketPath = process.env.UNREAL_AGENT_CAPABILITY_SOCKET;
const sessionId = process.env.UNREAL_AGENT_SESSION_ID;
if (!socketPath || !sessionId) {
  console.error("Capability broker is unavailable. Run this command inside Unreal Agent for Zed.");
  process.exit(2);
}
let request;
if (action === "list" || action === "search") {
  request = { sessionId, action: "list", query: first || "" };
} else if ((action === "web-search" || action === "web_search") && first) {
  let args;
  try { args = JSON.parse(first); }
  catch { console.error("Web search arguments must be JSON."); process.exit(2); }
  request = {
    sessionId, action: "web_search", objective: args.objective, queries: args.queries || args.search_queries,
    maxResults: args.max_results ?? args.maxResults,
    maxCharsPerResult: args.max_chars_per_result ?? args.maxCharsPerResult
  };
} else if ((action === "web-fetch" || action === "web_fetch") && first) {
  let args;
  try { args = JSON.parse(first); }
  catch { console.error("Web fetch arguments must be JSON."); process.exit(2); }
  request = { sessionId, action: "web_fetch", urls: args.urls, objective: args.objective, queries: args.queries || args.search_queries };
} else if ((action === "project-history" || action === "project_history") && first) {
  let args;
  try { args = JSON.parse(first); }
  catch { console.error("Project history arguments must be JSON."); process.exit(2); }
  request = {
    sessionId, action: "project_history", query: args.query,
    maxResults: args.max_results ?? args.maxResults,
    maxCharsPerResult: args.max_chars_per_result ?? args.maxCharsPerResult
  };
} else if (action === "request-write" && first) {
  let args;
  try { args = JSON.parse(first); }
  catch { console.error("Folder access arguments must be JSON."); process.exit(2); }
  request = { sessionId, action: "request_write", folders: args.folders, reason: args.reason };
} else if (action === "plan" && first) {
  let entries;
  try { entries = JSON.parse(first); }
  catch { console.error("Plan entries must be a JSON array."); process.exit(2); }
  request = { sessionId, action: "plan", entries };
} else if (action === "delegate" && first) {
  let args;
  try { args = JSON.parse(first); }
  catch { console.error("Delegate arguments must be JSON."); process.exit(2); }
  request = { sessionId, action: "delegate", agent: args.agent, task: args.task, context: args.context };
} else if (action === "swarm" && first) {
  let args;
  try { args = JSON.parse(first); }
  catch { console.error("Swarm arguments must be JSON."); process.exit(2); }
  request = { sessionId, action: "swarm", task: args.task, context: args.context, agents: args.agents, angles: args.angles };
} else if (action === "swarm-send" && first) {
  let args;
  try { args = JSON.parse(first); }
  catch { console.error("Swarm message arguments must be JSON, for example '{\"to\":\"all\",\"message\":\"...\"}'."); process.exit(2); }
  request = { sessionId, action: "swarm_send", to: args.to, message: args.message };
} else if (action === "browser" && first) {
  let args;
  try { args = JSON.parse(first); }
  catch { console.error("Browser arguments must be JSON, for example '{\"action\":\"open\",\"url\":\"http://localhost:3000\"}'."); process.exit(2); }
  if (!args || typeof args !== "object" || Array.isArray(args)) { console.error("Browser arguments must be a JSON object with an action."); process.exit(2); }
  request = { sessionId, action: "browser", arguments: args };
} else if (action === "swarm-inbox") {
  request = { sessionId, action: "swarm_inbox" };
} else if (action === "agents") {
  request = { sessionId, action: "agents" };
} else if (action === "schema" && first && second) {
  request = { sessionId, action: "schema", server: first, tool: second };
} else if (action === "call" && first && second) {
  let args = {};
  try { args = third ? JSON.parse(third) : {}; }
  catch { console.error("Tool arguments must be a JSON object."); process.exit(2); }
  request = { sessionId, action: "call", server: first, tool: second, arguments: args };
} else {
  console.error(usage);
  process.exit(2);
}
const socket = net.createConnection(socketPath);
let output = "";
socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
socket.on("data", (chunk) => { output += chunk.toString("utf8"); });
socket.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
socket.on("end", () => {
  try {
    const response = JSON.parse(output.trim());
    if (!response.ok) throw new Error(response.error);
    console.log(typeof response.result === "string" ? response.result : JSON.stringify(response.result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
});
