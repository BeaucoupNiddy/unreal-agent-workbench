// Manual "Run command" panel. Commands run on the server in the chat's folder
// under the chat's permission mode; output is shown as plain text only.
const HISTORY_LIMIT = 30;
const HISTORY_KEY = "unreal-console-command-history";
const SNIPPET_LIMIT = 12000;
const MODE_LABELS = {
  "read-only": "Read only sandbox",
  "workspace-write": "Workspace sandbox",
  "danger-full-access": "Full computer access"
};

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "").replace(/\r(?!\n)/g, "\n");
}

export function modeLabel(mode) { return MODE_LABELS[mode] || "Unknown permissions"; }

// Split a streamed NDJSON buffer into complete frames and the unfinished tail.
export function parseFrames(buffer) {
  const lines = buffer.split("\n");
  const rest = lines.pop();
  const frames = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { frames.push(JSON.parse(line)); } catch {}
  }
  return { frames, rest };
}

export function exitSummary(frame) {
  const seconds = `${((frame.durationMs || 0) / 1000).toFixed(1)}s`;
  if (frame.error) return `Could not start: ${frame.error}`;
  if (frame.timedOut) return `Timed out after ${seconds}`;
  if (frame.stopped) return `Stopped after ${seconds}`;
  if (frame.signal) return `Ended by ${frame.signal} after ${seconds}`;
  return `Exit ${frame.code} · ${seconds}`;
}

export function rememberCommand(history, command) {
  return [command, ...history.filter((item) => item !== command)].slice(0, HISTORY_LIMIT);
}

// A fenced block the user can send to the agent. Long output keeps its tail,
// which is usually where errors and test summaries are.
export function commandSnippet(command, output, summary) {
  let body = output.replace(/\n+$/, "");
  if (body.length > SNIPPET_LIMIT) body = `…(earlier output omitted)\n${body.slice(-SNIPPET_LIMIT)}`;
  const fence = body.includes("```") ? "~~~~" : "```";
  return `${fence}text\n$ ${command}\n${body}${body ? "\n" : ""}# ${summary}\n${fence}`;
}

function readHistory() {
  try { const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []; }
  catch { return []; }
}

export function setupRunCommand({ button, panel, getSessionId, insertIntoMessage, onOpen, showToast }) {
  const form = panel.querySelector(".command-form");
  const input = panel.querySelector(".command-input");
  const runButton = panel.querySelector(".command-run");
  const output = panel.querySelector(".command-output");
  const status = panel.querySelector(".command-status");
  const mode = panel.querySelector(".command-mode");
  const addButton = panel.querySelector(".command-add");
  const clearButton = panel.querySelector(".command-clear");
  const runs = new Map(); // sessionId -> { command, output, summary, mode, running }
  let history = readHistory();
  let historyIndex = -1;

  const current = () => runs.get(getSessionId());
  function render() {
    const run = current();
    output.textContent = run?.output || "";
    output.hidden = !run;
    status.textContent = run ? (run.running ? `Running: ${run.command}` : run.summary || "") : "Runs in this chat's project folder with the chat's permissions.";
    mode.textContent = run?.mode ? modeLabel(run.mode) : "";
    runButton.textContent = run?.running ? "Stop" : "Run";
    runButton.classList.toggle("stop", Boolean(run?.running));
    input.disabled = Boolean(run?.running);
    addButton.disabled = !run || run.running;
    clearButton.disabled = !run || run.running;
    output.scrollTop = output.scrollHeight;
  }

  function close() { panel.hidden = true; button.setAttribute("aria-expanded", "false"); }
  function open() {
    if (!getSessionId()) return;
    onOpen?.();
    panel.hidden = false; button.setAttribute("aria-expanded", "true");
    render(); if (!input.disabled) input.focus();
  }

  async function run(sessionId, command) {
    const entry = { command, output: "", summary: "", mode: "", running: true };
    runs.set(sessionId, entry);
    history = rememberCommand(history, command); historyIndex = -1;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {}
    render();
    const append = (text) => { entry.output += text; if (getSessionId() === sessionId) render(); };
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/command`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command })
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const parsed = parseFrames(done ? `${buffer}\n` : buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          if (frame.type === "start") { entry.mode = frame.mode; append(""); }
          else if (frame.type === "output") append(stripAnsi(frame.text));
          else if (frame.type === "notice") append(`\n[${frame.text}]\n`);
          else if (frame.type === "exit") entry.summary = exitSummary(frame);
          else if (frame.type === "error") entry.summary = frame.message;
        }
        if (done) break;
      }
      if (!entry.summary) entry.summary = "Connection closed before the command finished.";
    } catch (error) {
      entry.summary = error.message || "Could not run the command.";
    } finally {
      entry.running = false;
      if (getSessionId() === sessionId) render();
    }
  }

  async function stop(sessionId) {
    try { await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/command-stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); }
    catch (error) { showToast?.(error.message || "Could not stop the command."); }
  }

  button.addEventListener("click", () => (panel.hidden ? open() : close()));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const sessionId = getSessionId();
    if (!sessionId) return;
    if (runs.get(sessionId)?.running) return void stop(sessionId);
    const command = input.value.trim();
    if (!command) return;
    input.value = "";
    void run(sessionId, command);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!history.length) return;
    event.preventDefault();
    historyIndex = event.key === "ArrowUp" ? Math.min(historyIndex + 1, history.length - 1) : Math.max(historyIndex - 1, -1);
    input.value = historyIndex < 0 ? "" : history[historyIndex];
  });
  addButton.addEventListener("click", () => {
    const run = current();
    if (!run || run.running) return;
    insertIntoMessage(commandSnippet(run.command, run.output, run.summary));
    close();
  });
  clearButton.addEventListener("click", () => { runs.delete(getSessionId()); render(); input.focus(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) { close(); button.focus(); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close();
  });

  return { close, render, sync() { button.disabled = !getSessionId(); if (!panel.hidden) { if (getSessionId()) render(); else close(); } } };
}
