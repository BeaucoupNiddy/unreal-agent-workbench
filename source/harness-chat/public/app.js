import { setupKeyboardDismissal } from "./keyboard-dismissal.js";
import { renderMarkdown } from "./markdown.js";
import { copyMessage } from "./copy-message.js";

const $ = (selector) => document.querySelector(selector);
const STORAGE_KEY = "unreal-agent-chat-v1";
const ui = {
  sessionList: $("#sessionList"), welcome: $("#welcome"), messages: $("#messages"), prompt: $("#prompt"),
  composer: $("#composer"), send: $("#sendButton"), stop: $("#stopButton"), status: $("#runStatus"),
  statusText: $("#runStatusText"), workspaceName: $("#workspaceName"), topWorkspace: $("#topWorkspace"),
  connection: $("#connection"), dialog: $("#settingsDialog"), form: $("#settingsForm"), provider: $("#provider"),
  model: $("#model"), workspace: $("#workspace"), bashEnabled: $("#bashEnabled"),
  providerKey: $("#providerKey"), openRouterKey: $("#openRouterKey"), clearKey: $("#clearKey"),
  keyConfigured: $("#keyConfigured"), settingsError: $("#settingsError"), saveSettings: $("#saveSettings")
};

let settings = { provider: "openai-codex", model: "gpt-6-astra", workspace: "", bashEnabled: false, openRouterKeyConfigured: false };
let ready = false;
let currentId = null;
let sessions = [];
let running = false;
let activeController = null;

function loadLocalState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    sessions = Array.isArray(stored.sessions) ? stored.sessions : [];
    currentId = stored.currentId || null;
  } catch { sessions = []; currentId = null; }
  if (!sessions.some((session) => session.id === currentId)) currentId = sessions[0]?.id || null;
}
function saveLocalState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions: sessions.slice(0, 30), currentId })); }
  catch { showToast("Could not save conversation history in this browser."); }
}
function session() { return sessions.find((item) => item.id === currentId); }
function newSession() {
  if (running) return;
  const id = crypto.randomUUID();
  const item = { id, title: "New conversation", messages: [], updatedAt: Date.now() };
  sessions.unshift(item);
  currentId = id;
  saveLocalState();
  renderSessions();
  renderConversation();
  ui.prompt.focus();
  closeSidebar();
}
function setSession(id) {
  if (running || !sessions.some((item) => item.id === id)) return;
  currentId = id;
  saveLocalState();
  renderSessions();
  renderConversation();
  closeSidebar();
}
function renderSessions() {
  ui.sessionList.replaceChildren();
  for (const item of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-item${item.id === currentId ? " active" : ""}`;
    button.title = item.title;
    button.innerHTML = '<span class="session-icon" aria-hidden="true">▱</span>';
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = item.title || "New conversation";
    button.append(title);
    button.addEventListener("click", () => setSession(item.id));
    ui.sessionList.append(button);
  }
}
function renderConversation() {
  const active = session();
  ui.messages.replaceChildren();
  const hasMessages = Boolean(active?.messages?.length);
  ui.welcome.hidden = hasMessages;
  if (active) {
    for (const item of active.messages || []) renderMessage(item);
  }
  scrollToBottom();
}
function createMessage(role, text = "", extraClass = "") {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${role} ${extraClass}`.trim();
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "Y" : role === "error" ? "!" : "✳";
  avatar.setAttribute("aria-hidden", "true");
  const body = document.createElement("div");
  body.className = "message-body";
  const heading = document.createElement("div");
  heading.className = "message-heading";
  heading.textContent = role === "user" ? "You" : role === "error" ? "Notice" : "Unreal Agent";
  const content = document.createElement("div");
  content.className = "message-text";
  if (role === "assistant") content.innerHTML = renderMarkdown(text);
  else content.textContent = text;
  body.append(heading, content);
  if ((role === "user" || role === "assistant") && text) {
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "message-copy";
    copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect class="copy-glyph" x="8" y="8" width="12" height="12" rx="2"/><path class="copy-glyph" d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/><path class="copied-glyph" d="m5 12 4 4 10-10"/></svg>';
    copy.title = "Copy message with formatting";
    copy.setAttribute("aria-label", "Copy message with formatting");
    copy.addEventListener("click", async () => {
      try {
        await copyMessage(text);
        copy.classList.add("copied");
        copy.title = "Message copied";
        copy.setAttribute("aria-label", "Message copied");
      } catch {
        copy.classList.remove("copied");
        copy.title = "Check clipboard access and try again";
        copy.setAttribute("aria-label", "Copy failed. Check clipboard access and try again");
      }
    });
    body.append(copy);
  }
  wrapper.append(avatar, body);
  ui.messages.append(wrapper);
  return wrapper;
}
function renderMessage(item) {
  if (item.type === "user") {
    const wrapper = createMessage("user", item.text);
    if (item.id) wrapper.dataset.messageId = item.id;
    if (item.delivery) renderDelivery(item);
  }
  else if (item.type === "assistant") createMessage("assistant", item.text);
  else if (item.type === "error" || item.type === "notice") createMessage("error", item.text);
  else if (item.type === "tool") renderTool(item);
  else if (item.type === "reasoning") {
    const details = document.createElement("details");
    details.className = "reasoning";
    const summary = document.createElement("summary");
    summary.textContent = "Reasoning summary";
    const text = document.createElement("p");
    text.textContent = item.text;
    details.append(summary, text);
    ui.messages.append(details);
  }
}

function renderDelivery(item) {
  const wrapper = [...ui.messages.querySelectorAll(".message.user")].find((node) => node.dataset.messageId === item.id);
  if (!wrapper) return;
  wrapper.querySelector(".message-delivery")?.remove();
  const controls = document.createElement("div");
  controls.className = "message-delivery";
  if (item.delivery === "pending") {
    const hint = document.createElement("span");
    hint.textContent = "Send this while Unreal Agent is working:";
    controls.append(hint);
    for (const mode of ["steer", "queue"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = mode === "steer" ? "Steer" : "Queue";
      button.addEventListener("click", () => chooseDelivery(item, mode));
      controls.append(button);
    }
  } else {
    const label = document.createElement("span");
    const labels = {
      steering: "Steering the current response…", steered: "Steered the current response",
      queued: "Queued for after this response", sending: "Sending…", cancelled: "Not sent"
    };
    label.textContent = labels[item.delivery] || "";
    controls.append(label);
  }
  wrapper.querySelector(".message-body").append(controls);
}
function renderTool(item) {
  const card = document.createElement("div");
  card.className = `tool-card ${item.status || "started"}`;
  if (item.id) card.dataset.callId = item.id;
  const summary = document.createElement("div");
  summary.className = "tool-summary";
  summary.textContent = item.name || "Tool";
  card.append(summary);
  const detail = document.createElement("pre");
  detail.textContent = item.detail || "";
  if (detail.textContent) card.append(detail);
  ui.messages.append(card);
}
function updateTool(item) {
  const matching = item.id && [...ui.messages.querySelectorAll(".tool-card")].find((card) => card.dataset.callId === item.id);
  if (!matching) { renderTool(item); return; }
  matching.className = `tool-card ${item.status || "updated"}`;
  const oldDetail = matching.querySelector("pre");
  if (item.detail && oldDetail) oldDetail.textContent = `${oldDetail.textContent}\n${item.detail}`;
  else if (item.detail) {
    const detail = document.createElement("pre");
    detail.textContent = item.detail;
    matching.append(detail);
  }
}
function pushMessage(item) {
  const active = session();
  if (!active) return;
  active.messages.push(item);
  active.updatedAt = Date.now();
  if (item.type === "user" && active.title === "New conversation") {
    active.title = item.text.replace(/\s+/g, " ").slice(0, 42) || "New conversation";
  }
  saveLocalState();
  renderMessage(item);
  ui.welcome.hidden = true;
  renderSessions();
  scrollToBottom();
}
function persistEvent(item) {
  if (item.type === "tool") {
    const active = session();
    if (item.status === "started") {
      active?.messages.push(item);
      renderTool(item);
    } else {
      const previous = active?.messages.findLast?.((entry) => entry.type === "tool" && entry.id === item.id);
      if (previous) Object.assign(previous, item);
      else active?.messages.push(item);
      updateTool(item);
    }
  } else if (["assistant", "reasoning", "error", "notice"].includes(item.type)) {
    pushMessage(item);
  }
  saveLocalState();
  scrollToBottom();
}
function scrollToBottom() { requestAnimationFrame(() => ui.messages.scrollIntoView({ block: "end", behavior: "smooth" })); }
function setRunning(value) {
  running = value;
  ui.send.hidden = false;
  ui.stop.hidden = !value;
  ui.status.hidden = !value;
  if (!value) ui.prompt.focus();
}
function setConnection(isReady, label) {
  ready = isReady;
  ui.connection.className = `connection ${isReady ? "ready" : "offline"}`;
  ui.connection.querySelector("span").textContent = label;
}
function showToast(message) {
  ui.settingsError.textContent = message;
  if (ui.dialog.open) return;
  // Errors outside settings use the connection indicator, avoiding transient blocking alerts.
  ui.connection.className = "connection offline";
  ui.connection.querySelector("span").textContent = message;
}
async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
async function refreshStatus() {
  try {
    const data = await requestJson("/api/status");
    settings = { ...settings, ...data.settings };
    setConnection(Boolean(data.ready), data.ready ? "Harness ready" : "Runner not found");
    updateWorkspaceLabels();
    if (!data.ready) showToast("Unreal Agent runner not found");
  } catch (error) {
    setConnection(false, "Server unavailable");
  }
}
function updateWorkspaceLabels() {
  const name = settings.workspace ? settings.workspace.split("/").filter(Boolean).pop() || settings.workspace : "Choose a folder";
  ui.workspaceName.textContent = name;
  ui.workspaceName.title = settings.workspace || "";
  ui.topWorkspace.textContent = name;
  ui.topWorkspace.title = settings.workspace || "";
}
function openSettings() {
  ui.settingsError.textContent = "";
  ui.provider.value = settings.provider;
  ui.model.value = settings.model;
  ui.workspace.value = settings.workspace;
  ui.bashEnabled.checked = settings.bashEnabled;
  ui.openRouterKey.value = "";
  ui.clearKey.checked = false;
  ui.keyConfigured.textContent = settings.openRouterKeyConfigured ? "(key saved)" : "(not configured)";
  updateProviderFields();
  ui.dialog.showModal();
}
function updateProviderFields() {
  ui.providerKey.hidden = ui.provider.value !== "openrouter";
  ui.clearKey.disabled = !settings.openRouterKeyConfigured;
}
async function saveSettings(event) {
  event.preventDefault();
  ui.settingsError.textContent = "";
  ui.saveSettings.disabled = true;
  try {
    const payload = {
      provider: ui.provider.value,
      model: ui.model.value.trim(),
      workspace: ui.workspace.value.trim(),
      bashEnabled: ui.bashEnabled.checked,
      openRouterKey: ui.openRouterKey.value,
      clearOpenRouterKey: ui.clearKey.checked
    };
    const result = await requestJson("/api/settings", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    });
    settings = { ...settings, ...result.settings };
    ui.dialog.close();
    updateWorkspaceLabels();
    await refreshStatus();
  } catch (error) {
    ui.settingsError.textContent = error.message;
  } finally { ui.saveSettings.disabled = false; }
}
async function browseFolder() {
  ui.settingsError.textContent = "";
  try {
    const result = await requestJson("/api/pick-folder", { method: "POST" });
    ui.workspace.value = result.workspace;
  } catch (error) {
    ui.settingsError.textContent = error.message;
  }
}
async function chooseDelivery(item, mode) {
  if (item.delivery !== "pending") return;
  if (mode === "queue") {
    item.delivery = "queued";
    queuedMessages.push(item);
    renderDelivery(item);
    saveLocalState();
    return;
  }
  item.delivery = "steering";
  renderDelivery(item);
  saveLocalState();
  try {
    await requestJson("/api/steer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: item.text, sessionId: currentId })
    });
    item.delivery = "steered";
  } catch {
    // The response may have completed between sending the message and choosing Steer.
    item.delivery = "queued";
    queuedMessages.push(item);
    if (!running) {
      queuedMessages = queuedMessages.filter((queued) => queued !== item);
      void runSequence(item.text);
    }
  }
  renderDelivery(item);
  saveLocalState();
}

let queuedMessages = [];
async function sendMessage(text) {
  if (!ready) {
    showToast("Runner unavailable — check setup and try again.");
    return;
  }
  if (!currentId) newSession();
  const active = session();
  if (!active) return;
  const prompt = text.trim();
  if (!prompt) return;
  const item = { id: crypto.randomUUID(), type: "user", text: prompt };
  if (running) item.delivery = "pending";
  pushMessage(item);
  ui.prompt.value = "";
  resizePrompt();
  if (running) {
    renderDelivery(item);
    saveLocalState();
    return;
  }
  queuedMessages = [];
  void runSequence(prompt);
}

async function runSequence(firstPrompt) {
  setRunning(true);
  ui.statusText.textContent = "Unreal Agent is working…";
  let prompt = firstPrompt;
  while (prompt) {
    const completed = await runPrompt(prompt);
    if (!completed) {
      for (const item of queuedMessages) { item.delivery = "cancelled"; renderDelivery(item); }
      queuedMessages = [];
      break;
    }
    const next = queuedMessages.shift();
    if (next) {
      next.delivery = "sending";
      renderDelivery(next);
      saveLocalState();
    }
    prompt = next?.text || "";
  }
  activeController = null;
  setRunning(false);
  saveLocalState();
}

async function runPrompt(prompt) {
  activeController = new AbortController();
  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, sessionId: currentId }), signal: activeController.signal
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Harness error (${response.status}).`);
    }
    if (!response.body) throw new Error("The server did not provide a response stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "run") {
            if (event.status === "started") ui.statusText.textContent = "Unreal Agent is working…";
            else ui.statusText.textContent = event.status === "complete" ? "Finished" : "Run stopped";
          } else persistEvent(event);
        } catch { /* Ignore malformed stream lines; the server reports these as notices. */ }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      try { const event = JSON.parse(buffer); if (event.type !== "run") persistEvent(event); } catch {}
    }
    return true;
  } catch (error) {
    if (error.name !== "AbortError") pushMessage({ type: "error", text: error.message });
    return error.name !== "AbortError";
  } finally {
    activeController = null;
  }
}

async function stopRun() {
  if (!running || !currentId) return;
  ui.stop.disabled = true;
  try {
    await requestJson("/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: currentId }) });
  } catch {}
  for (const item of queuedMessages) { item.delivery = "cancelled"; renderDelivery(item); }
  for (const item of session()?.messages || []) {
    if (item.type === "user" && ["steering", "steered", "sending"].includes(item.delivery)) {
      item.delivery = "cancelled";
      renderDelivery(item);
    }
  }
  queuedMessages = [];
  activeController?.abort();
  ui.stop.disabled = false;
}
function resizePrompt() {
  ui.prompt.rows = Math.min(7, Math.max(1, ui.prompt.value.split("\n").length));
}
function closeSidebar() { $("#sidebar").classList.remove("open"); }

$("#newChat").addEventListener("click", newSession);
$("#mobileNewChat").addEventListener("click", newSession);
$("#openSettings").addEventListener("click", openSettings);
$("#topSettings").addEventListener("click", openSettings);
$("#closeSettings").addEventListener("click", () => ui.dialog.close());
$("#cancelSettings").addEventListener("click", () => ui.dialog.close());
$("#provider").addEventListener("change", updateProviderFields);
$("#browseFolder").addEventListener("click", browseFolder);
ui.form.addEventListener("submit", saveSettings);
ui.composer.addEventListener("submit", (event) => { event.preventDefault(); sendMessage(ui.prompt.value); });
ui.prompt.addEventListener("input", resizePrompt);
setupKeyboardDismissal(ui.prompt, $("#hideKeyboard"));
ui.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !window.matchMedia("(pointer: coarse)").matches) {
    event.preventDefault(); ui.composer.requestSubmit();
  }
});
ui.stop.addEventListener("click", stopRun);
$("#mobileMenu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
document.addEventListener("click", (event) => {
  const suggestion = event.target.closest("[data-prompt]");
  if (suggestion) { ui.prompt.value = suggestion.dataset.prompt; resizePrompt(); ui.prompt.focus(); }
  if (event.target === ui.dialog) ui.dialog.close();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); newSession(); }
  if ((event.metaKey || event.ctrlKey) && event.key === ",") { event.preventDefault(); openSettings(); }
  if (event.key === "Escape") closeSidebar();
});

loadLocalState();
renderSessions();
if (!currentId) newSession();
else renderConversation();
refreshStatus();
