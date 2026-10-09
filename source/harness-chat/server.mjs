import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const host = "127.0.0.1";
const port = Number(process.env.PORT || 4317);
const runner = process.env.UNREAL_AGENT_RUNNER || "unreal-agent-runner";
const dataDir = path.join(homedir(), "Library", "Application Support", "Harness Chat");
const settingsPath = path.join(dataDir, "settings.json");
const sessionDirectory = path.join(dataDir, "sessions");
const logDirectory = path.join(dataDir, "logs");
const keychainService = "Harness Chat OpenRouter";
const keychainAccount = userInfo().username;
const activeRuns = new Map();

const defaults = {
  provider: "openai-codex",
  model: "gpt-6-astra",
  workspace: root,
  bashEnabled: false
};

await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Request must be valid JSON.");
  }
}

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    return { ...defaults, ...parsed };
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read settings:", error.message);
    return { ...defaults };
  }
}

async function saveSettings(settings) {
  const temporary = `${settingsPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fs.rename(temporary, settingsPath);
  await fs.chmod(settingsPath, 0o600);
}

async function getOpenRouterKey() {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password", "-a", keychainAccount, "-s", keychainService, "-w"
    ]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function setOpenRouterKey(value) {
  if (!value) {
    try {
      await execFileAsync("/usr/bin/security", [
        "delete-generic-password", "-a", keychainAccount, "-s", keychainService
      ]);
    } catch {}
    return;
  }
  await execFileAsync("/usr/bin/security", [
    "add-generic-password", "-U", "-a", keychainAccount,
    "-s", keychainService, "-w", value
  ]);
}

async function runnerAvailable() {
  try {
    await execFileAsync("/usr/bin/which", [runner]);
    return true;
  } catch {
    return false;
  }
}

function publicSettings(settings, hasKey) {
  return {
    provider: settings.provider,
    model: settings.model,
    workspace: settings.workspace,
    bashEnabled: Boolean(settings.bashEnabled),
    openRouterKeyConfigured: hasKey
  };
}

function cleanSettings(input, previous) {
  const provider = input.provider === "openrouter" ? "openrouter" : "openai-codex";
  const model = String(input.model || "").trim();
  const workspace = String(input.workspace || previous.workspace || "").trim();
  if (!model || model.length > 160) throw new Error("Enter a model name.");
  if (!workspace) throw new Error("Choose a workspace folder.");
  return { provider, model, workspace, bashEnabled: Boolean(input.bashEnabled) };
}

async function validateWorkspace(workspace) {
  const resolved = path.resolve(workspace);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("The workspace folder does not exist.");
  return resolved;
}

function transformEvent(event) {
  if (event?.type === "error") return [{ type: "error", text: event.message || "Harness error" }];
  if (event?.Kind === "model_response") {
    const output = event.Data?.Response?.Output || [];
    return output.flatMap((item) => {
      if (item.Type === "message" && item.Data?.Text) {
        return [{ type: "assistant", text: item.Data.Text, phase: item.Data.Phase || "message" }];
      }
      if (item.Type === "tool_call") {
        const detail = item.Data?.Name === "Bash"
          ? safelyParseCommand(item.Data?.Arguments)
          : item.Data?.Name || "Tool";
        return [{
          type: "tool",
          id: item.Data?.CallID || item.Data?.CallId,
          name: item.Data?.Name || "Tool",
          detail,
          status: "started"
        }];
      }
      if (item.Type === "reasoning" && item.Data?.Summary?.length) {
        return [{ type: "reasoning", text: item.Data.Summary.join("\n") }];
      }
      if (item.Type === "provider" && item.Data?.Display?.Kind === "reasoning" && item.Data.Display.Text) {
        return [{ type: "reasoning", text: item.Data.Display.Text }];
      }
      return [];
    });
  }
  if (event?.Kind === "tool_call_status") {
    const operation = event.Data?.Operations?.[0];
    return [{
      type: "tool",
      id: event.Data?.CallID || event.Data?.CallId,
      name: operation?.Type || "Tool",
      detail: event.Data?.Status?.Error || operation?.Status || "updated",
      status: event.Data?.Status?.Error ? "failed" : operation?.Status || "updated"
    }];
  }
  return [];
}

function safelyParseCommand(argumentsText) {
  try {
    return JSON.parse(argumentsText || "{}").command || "Bash command";
  } catch {
    return "Bash command";
  }
}

function streamEvent(res, value) {
  if (!res.writableEnded) res.write(`${JSON.stringify(value)}\n`);
}

function interruptRunChild(run, child = run.child) {
  if (!child || child.exitCode !== null || run.child !== child) return false;
  child.kill("SIGINT");
  setTimeout(() => {
    if (child.exitCode === null && run.child === child) child.kill("SIGKILL");
  }, 2500).unref();
  return true;
}

function trackRunEvent(run, child, event) {
  if (event?.Kind === "input" && event.Data?.Kind === "external") {
    run.currentInputPersisted = true;
  }
  if (event?.Kind === "model_response") {
    for (const item of event.Data?.Response?.Output || []) {
      if (item.Type === "tool_call") {
        const id = item.Data?.CallID || item.Data?.CallId;
        if (id) run.activeToolCalls.add(id);
      }
    }
  }
  if (event?.Kind === "tool_call_status") {
    const id = event.Data?.CallID || event.Data?.CallId;
    const operations = event.Data?.Operations || [];
    const terminal = new Set(["completed", "failed", "canceled", "cancelled"]);
    const finished = Boolean(event.Data?.Status?.Error) ||
      (operations.length > 0 && operations.every((operation) => terminal.has(String(operation.Status).toLowerCase())));
    if (id && finished) run.activeToolCalls.delete(id);
  }
  if (run.interruptRequested && !run.interruptSent && run.currentInputPersisted && run.activeToolCalls.size === 0) {
    run.interruptSent = interruptRunChild(run, child) || run.interruptSent;
  }
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const prompt = String(body.prompt || "").trim();
  const sessionId = String(body.sessionId || "").trim();
  if (!prompt || prompt.length > 100_000) throw new Error("Enter a message.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/.test(sessionId)) throw new Error("Invalid session.");
  if (activeRuns.has(sessionId)) throw new Error("This conversation is already running.");

  const settings = await loadSettings();
  settings.workspace = await validateWorkspace(settings.workspace);
  const env = { ...process.env, UNREAL_HARNESS_LLM_PROVIDER: settings.provider, UNREAL_HARNESS_LLM_MODEL: settings.model };
  if (settings.provider === "openrouter") {
    const key = await getOpenRouterKey();
    if (!key) throw new Error("Add your OpenRouter key in Settings first.");
    env.OPENROUTER_API_KEY = key;
  }

  const request = {
    session_id: sessionId,
    model: settings.model,
    thinking_level: "high",
    system_prompt: [
      "You are a careful local coding assistant.",
      "Work only inside the selected workspace.",
      "Do not access parent directories, credentials, private keys, or unrelated files.",
      "Never delete files or perform destructive actions.",
      "Explain completed work clearly."
    ].join(" "),
    disallowed_tools: settings.bashEnabled ? [] : ["Bash"]
  };
  const argsFor = (currentPrompt) => [
    "-workspace", settings.workspace,
    "-session-directory", sessionDirectory,
    "-log-directory", logDirectory,
    JSON.stringify({ ...request, prompt: currentPrompt })
  ];

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  streamEvent(res, { type: "run", status: "started", sessionId });

  const run = {
    child: null, pendingSteers: [], activeToolCalls: new Set(),
    currentInputPersisted: false, interruptRequested: false, interruptSent: false, cancelled: false
  };
  activeRuns.set(sessionId, run);
  res.on("close", () => {
    if (!res.writableEnded) {
      run.cancelled = true;
      run.pendingSteers.length = 0;
      interruptRunChild(run);
    }
  });

  let nextPrompt = prompt;
  let finalStatus = "complete";
  while (nextPrompt && !run.cancelled) {
    run.currentInputPersisted = false;
    run.activeToolCalls = new Set();
    run.interruptRequested = run.pendingSteers.length > 0;
    run.interruptSent = false;
    const child = spawn(runner, argsFor(nextPrompt), { env, stdio: ["ignore", "pipe", "pipe"] });
    run.child = child;
    let stdoutBuffer = "";
    let stderr = "";
    const emitLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        trackRunEvent(run, child, event);
        for (const item of transformEvent(event)) streamEvent(res, item);
      } catch {
        streamEvent(res, { type: "notice", text: "Received an unreadable harness event." });
      }
    };
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) emitLine(line);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
    child.on("error", (error) => streamEvent(res, { type: "error", text: error.message }));
    const { code, signal } = await new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (stdoutBuffer.trim()) emitLine(stdoutBuffer);
    if (run.child === child) run.child = null;

    const interruptedForSteer = run.pendingSteers.length > 0;
    if (interruptedForSteer) {
      // Runner sessions are persisted; restarting with this added input continues the same conversation.
      nextPrompt = run.pendingSteers.splice(0).join("\n\n");
      continue;
    }
    nextPrompt = "";
    if (code && stderr.trim() && !run.cancelled) {
      streamEvent(res, { type: "error", text: stderr.trim() });
      finalStatus = "failed";
    } else if (signal || run.cancelled) {
      finalStatus = "stopped";
    }
  }
  if (activeRuns.get(sessionId) === run) activeRuns.delete(sessionId);
  streamEvent(res, { type: "run", status: finalStatus });
  res.end();
}

async function handleSteer(req, res) {
  const body = await readBody(req);
  const prompt = String(body.prompt || "").trim();
  const sessionId = String(body.sessionId || "").trim();
  if (!prompt || prompt.length > 100_000) throw new Error("Enter a message.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/.test(sessionId)) throw new Error("Invalid session.");
  const run = activeRuns.get(sessionId);
  if (!run || run.cancelled) return json(res, 409, { error: "This response has already finished." });
  run.pendingSteers.push(prompt);
  run.interruptRequested = true;
  if (!run.interruptSent && run.currentInputPersisted && run.activeToolCalls.size === 0) {
    run.interruptSent = interruptRunChild(run) || run.interruptSent;
  }
  return json(res, 200, { steered: true });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(publicDir, `.${requestPath}`);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) return json(res, 404, { error: "Not found" });
  try {
    const body = await fs.readFile(filePath);
    const extensions = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, {
      "content-type": extensions[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  try {
    if (!checkOrigin(req)) return json(res, 403, { error: "Request origin is not allowed." });
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      const settings = await loadSettings();
      return json(res, 200, {
        ready: await runnerAvailable(),
        settings: publicSettings(settings, Boolean(await getOpenRouterKey()))
      });
    }

    if (req.method === "POST" && url.pathname === "/api/settings") {
      const body = await readBody(req);
      const previous = await loadSettings();
      const settings = cleanSettings(body, previous);
      settings.workspace = await validateWorkspace(settings.workspace);
      const suppliedKey = String(body.openRouterKey || "").trim();
      if (suppliedKey && suppliedKey.length < 24) throw new Error("That OpenRouter key looks incomplete.");
      if (suppliedKey) await setOpenRouterKey(suppliedKey);
      if (body.clearOpenRouterKey) await setOpenRouterKey("");
      await saveSettings(settings);
      return json(res, 200, { settings: publicSettings(settings, Boolean(await getOpenRouterKey())) });
    }

    if (req.method === "POST" && url.pathname === "/api/pick-folder") {
      const { stdout } = await execFileAsync("/usr/bin/osascript", [
        "-e", "POSIX path of (choose folder with prompt \"Choose a workspace for Harness Chat\")"
      ]);
      return json(res, 200, { workspace: stdout.trim().replace(/\/$/, "") });
    }

    if (req.method === "POST" && url.pathname === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && url.pathname === "/api/steer") return await handleSteer(req, res);

    if (req.method === "POST" && url.pathname === "/api/stop") {
      const { sessionId } = await readBody(req);
      const run = activeRuns.get(String(sessionId));
      if (run) {
        run.cancelled = true;
        run.pendingSteers.length = 0;
        interruptRunChild(run);
      }
      return json(res, 200, { stopped: Boolean(run) });
    }

    if (req.method === "GET") return await serveStatic(req, res);
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 400, { error: error.message || "Request failed." });
  }
});

server.listen(port, host, () => {
  console.log(`Unreal Agent Chat is ready at http://${host}:${port}`);
});

process.on("SIGINT", () => {
  for (const run of activeRuns.values()) {
    run.cancelled = true;
    interruptRunChild(run);
  }
  server.close(() => process.exit(0));
});
