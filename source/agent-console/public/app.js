import { renderApprovalPanel } from "./approval-panel.js";
import { folderApprovalReply } from "./folder-permissions.js";
import { setupKeyboardDismissal } from "./keyboard-dismissal.js";
import { renderMarkdown } from "./markdown.js";
import { copyMessage } from "./copy-message.js";
import { applyModelFavorites } from "./favorites.js";
import { activitySummary, groupTranscriptEntries } from "./activity.js";
import { timelineReasoningText, timelineToolLabel } from "./timeline-label.js";
import { startProgress, finishProgress, recordTool, recordResponse, progressSnapshot, hydrateProgress, recordThought, progressGroups } from "./live-progress.js";
import { taskStatus } from "./task-state.js";
import { appendMessageChunk, appendToolCall } from "./transcript.js";
import { createScrollFollow } from "./scroll-follow.js";
import { isDelegateCommand, isSubagentUpdate, renderSubagentGroup, tickSubagentTimers, upsertSubagent } from "./subagent-view.js";
import { moveId, moveIdBy, orderedByIds } from "./sidebar-order.js";
import { clampSidebarWidth, sidebarWidthLimit, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from "./sidebar-width.js";
import { apiEquivalent, assumesCacheReadRate, threadContextPercent } from "./usage-equivalent.js";
import { formatDashboardTokens } from "./dashboard-format.js";
import { subscriptionIncrease } from "./subscription-delta.js";
import { RecentTranscripts } from "./recent-transcripts.js";
import { newInputId, recoverInputId, finishInputId } from "./input-recovery.js";
import { setupRunCommand } from "./run-command.js";
import { addChoices, appendSubagent, applyModelToCards, collectSubagents, delegationChoices, inheritModel, modelChoices, renderSubagents, subagentPresets } from "./agents-settings.js";

const $ = (selector) => document.querySelector(selector);
const PENDING_DRAFTS_KEY = "unreal-console-pending-drafts";
const BRANDING = {
  default: {
    name: "Unreal Agent",
    consoleLabel: "UNREAL AGENT CONSOLE",
    favicon: "/favicon.svg",
    manifest: "/manifest.webmanifest",
    initials: "UA",
    prompt: "Ask Unreal Agent anything",
    footnote: "Unreal Agent runs locally. Review important changes before shipping."
  },
  jambalaya: {
    name: "Jambalaya Agent",
    consoleLabel: "JAMBALAYA AGENT CONSOLE",
    favicon: "/favicon-jambalaya.svg",
    manifest: "/manifest-jambalaya.webmanifest",
    initials: "JA",
    prompt: "Ask Jambalaya Agent anything",
    footnote: "Jambalaya Agent runs locally. Review important changes before shipping."
  }
};
const state = {
  sessions: [], projects: [], removedProjectPaths: [], oneOffWorkspacePath: null, expandedProjectPaths: new Set(), currentProjectPath: null, currentId: null, ready: false, stream: null, configOptions: [], modelFavorites: [],
  sidebarOrder: { projects: [], chats: {} },
  queuedInputs: [], entries: [], byMessage: new Map(), byTool: new Map(), running: false, promptRequests: 0, stopping: false, taskError: "", connection: "Connecting", creatingChat: false, submitting: false, attachments: [],
  pendingDeleteId: null, deletingChat: false, pendingProjectId: null, editingProjectId: null, editingProjectPath: null, editingLegacyProject: false, deletingProject: false,
  capabilities: { appleNotes: true, appleCalendar: true },
  generation: { memoryEnabled: true, memoryModel: "gpt-6-luna", titleEnabled: true, titleModel: "gpt-6-luna" },
  generationModels: [],
  localPresets: [], editingLocalProvider: null, localProviderBusy: false,
  modelProviders: [], catalogProvider: null, catalogLoading: false, refreshingModels: false, catalogError: "", modelSettingsReady: false, preferencesLoadId: 0,
  configReady: null, resolveConfigReady: null, configReadyTimeout: null,
  openActivityGroups: new Set(),
  openToolCalls: new Set(), expandedNotes: new Set(),
  liveProgress: null, progressTurns: [], selectedProgressTurn: null, expandedProgressTools: new Set(),
  openControl: null,
  openRouterKey: null, currentProvider: null, subscriptionUsage: {}, subscriptionRequest: 0, subscriptionBaseline: null, usageReference: null,
  usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, costAmount: null, costKnown: false, used: 0, size: 0 },
  prefs: { theme: "system", accent: "lime", showThoughts: true, jambalayaMode: false, usageMetric: "auto" }
};

const recentTranscripts = new RecentTranscripts();
let replayingHistory = false;

function cacheCurrentTranscript() {
  if (!state.currentId) return;
  recentTranscripts.put(state.currentId, {
    entries: state.entries, byMessage: state.byMessage, byTool: state.byTool,
    openActivityGroups: state.openActivityGroups, openToolCalls: state.openToolCalls,
    progressTurns: state.progressTurns, liveProgress: state.liveProgress,
    usage: state.usage, configOptions: state.configOptions, modelFavorites: state.modelFavorites,
    running: state.running, promptRequests: state.promptRequests, taskError: state.taskError
  });
}

function restoreTranscript(snapshot) {
  for (const key of ["entries", "byMessage", "byTool", "openActivityGroups", "openToolCalls",
    "progressTurns", "liveProgress", "usage", "configOptions", "modelFavorites", "running", "promptRequests", "taskError"]) {
    state[key] = snapshot[key];
  }
  state.selectedProgressTurn = null;
  renderUsageLabel();
  renderTranscript();
}

const ui = {
  sidebar: $("#sidebar"), sessionList: $("#sessionList"), sessionCount: $("#sessionCount"),
  taskTitle: $("#taskTitle"), taskPath: $("#taskPath"), liveState: $("#liveState"), timelineButton: $("#timelineButton"), liveProgressPanel: $("#liveProgressPanel"),
  emptyState: $("#emptyState"), messages: $("#messages"), prompt: $("#prompt"),
  followupQueue: $("#followupQueue"), composer: $("#composer"), composerContext: $("#composerContext"), toast: $("#toast"), stopTask: $("#stopTask"),
  attachmentList: $("#attachmentList"), imagePicker: $("#imagePicker"), dropOverlay: $("#dropOverlay"),
  conversation: $("#conversation"), jumpLatest: $("#jumpLatest"), controlStrip: $("#controlStrip"), controlPopover: $("#controlPopover"),
  preferencesDialog: $("#preferencesDialog"), deleteChatDialog: $("#deleteChatDialog"),
  deleteChatTitle: $("#deleteChatTitle"), deleteChatCopy: $("#deleteChatCopy"), confirmDeleteChat: $("#confirmDeleteChat"),
  projectDialog: $("#projectDialog"), deleteProjectDialog: $("#deleteProjectDialog"),
  chatSearchDialog: $("#chatSearchDialog"), chatSearchInput: $("#chatSearchInput"),
  chatSearchStatus: $("#chatSearchStatus"), chatSearchResults: $("#chatSearchResults")
};
const scrollFollow = createScrollFollow(ui.conversation, { onChange: (following) => { if (following) ui.jumpLatest.hidden = true; } });
ui.jumpLatest.addEventListener("click", () => scrollFollow.follow());

let commandPanel = null;
function basename(value = "") { return value.split("/").filter(Boolean).pop() || value || "Workspace"; }
function brand() { return state.prefs.jambalayaMode ? BRANDING.jambalaya : BRANDING.default; }
function displayModel(value) {
  const model = value?.split("/").pop();
  return model === "Unreal Agent" ? brand().name : model || brand().name;
}
function applyBranding() {
  const current = brand();
  document.body.dataset.brand = state.prefs.jambalayaMode ? "jambalaya" : "default";
  document.title = current.name;
  document.querySelector('meta[name="description"]').content = `A focused local console for ${current.name}.`;
  document.querySelector('meta[name="apple-mobile-web-app-title"]').content = current.name;
  $("#favicon").href = current.favicon;
  $("#manifest").href = current.manifest;
  $("#brandHome").setAttribute("aria-label", `${current.name} home`);
  $("#brandName").textContent = current.name;
  $("#brandEyebrow").textContent = current.consoleLabel;
  $("#brandFootnote").textContent = current.footnote;
  ui.prompt.placeholder = current.prompt;
  ui.prompt.setAttribute("aria-label", `Message ${current.name}`);
  updateThemeColor();
}
function relativeTime(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}
function showToast(message) {
  ui.toast.textContent = message; ui.toast.hidden = false;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { ui.toast.hidden = true; }, 3600);
}
function currentTaskStatus() {
  return taskStatus({ chat: Boolean(state.currentId), project: Boolean(state.currentProjectPath),
    ready: state.ready, connection: state.connection, running: state.running,
    submitting: state.submitting, stopping: state.stopping, error: state.taskError, entries: state.entries });
}
function renderTaskStatus() {
  const status = currentTaskStatus();
  const label = ui.liveState.querySelector("span");
  ui.liveState.className = `live-state ${status.kind}`;
  if (label.textContent !== status.label) label.textContent = status.label;
  ui.liveState.disabled = !state.progressTurns.length;
  ui.timelineButton.disabled = !state.currentId;
  commandPanel?.sync();
  ui.liveState.title = state.progressTurns.length ? `View turn timeline — ${status.label}` : (status.detail ? `${status.label} — ${status.detail}` : status.label);
  return status;
}
function setConnection(ready, label) {
  state.ready = ready; state.connection = label;
  renderTaskStatus();
}
function requestJson(url, options = {}) {
  return fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      return data;
    });
}
function sessionState(item) { return item.busy ? "busy" : item.status === "warm" ? "warm" : "cold"; }

// Keep empty chats recoverable while Hydra waits for the first message before
// including them in its normal session listing.
function loadPendingDrafts() {
  try {
    const drafts = JSON.parse(localStorage.getItem(PENDING_DRAFTS_KEY) || "[]");
    if (!Array.isArray(drafts)) return;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    state.sessions = drafts.filter((item) => item?.draft && item.sessionId && item.cwd && new Date(item.updatedAt).getTime() >= cutoff)
      .map((item) => ({ ...item, pendingRemote: true }));
  } catch { state.sessions = []; }
}
function savePendingDrafts() {
  const drafts = state.sessions.filter((item) => item.pendingRemote || item.draft)
    .map(({ sessionId, upstreamSessionId, cwd, title, agentId, currentModel, updatedAt, status }) => ({
      sessionId, upstreamSessionId, cwd, title: title || "New chat", agentId: agentId || "unreal",
      currentModel, updatedAt, status: status || "cold", busy: false, draft: true
    }));
  try { localStorage.setItem(PENDING_DRAFTS_KEY, JSON.stringify(drafts)); } catch {}
}

function pathContains(root, child) {
  const cleanRoot = root.replace(/\/+$/, "") || "/";
  return child === cleanRoot || child.startsWith(cleanRoot === "/" ? "/" : `${cleanRoot}/`);
}
function projectViews() {
  const views = state.projects.map((project) => ({ ...project, saved: true }));
  for (const item of state.sessions) {
    if (state.oneOffWorkspacePath && pathContains(state.oneOffWorkspacePath, item.cwd)) continue;
    if (!item.cwd || views.some((project) => pathContains(project.path, item.cwd))) continue;
    if (state.removedProjectPaths.some((removedPath) => pathContains(removedPath, item.cwd))) continue;
    if (!views.some((project) => project.path === item.cwd)) {
      views.push({ id: `legacy:${item.cwd}`, name: basename(item.cwd), path: item.cwd, saved: false });
    }
  }
  const sorted = views.sort((a, b) => a.name.localeCompare(b.name));
  return orderedByIds(sorted, state.sidebarOrder.projects, (project) => project.id);
}
function loadSidebarOrder() {
  try {
    const value = JSON.parse(localStorage.getItem("unreal-console-sidebar-order") || "{}");
    state.sidebarOrder = {
      projects: Array.isArray(value.projects) ? value.projects.filter((id) => typeof id === "string") : [],
      chats: value.chats && typeof value.chats === "object" ? value.chats : {}
    };
  } catch { state.sidebarOrder = { projects: [], chats: {} }; }
}
function saveSidebarOrder() {
  try { localStorage.setItem("unreal-console-sidebar-order", JSON.stringify(state.sidebarOrder)); } catch {}
}
function chatGroupKey(project) { return project ? `project:${project.id}` : "one-off"; }
function orderedChats(chats, key) {
  const recent = [...chats].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const ids = state.sidebarOrder.chats[key] || [];
  return orderedByIds(recent, ids, (chat) => chat.sessionId);
}
function ensureOrder(ids, items, getId) {
  const existing = new Set(items.map(getId));
  return [...ids.filter((id) => existing.has(id)), ...items.map(getId).filter((id) => !ids.includes(id))];
}
function reorderProjects(id, targetId, after = false) {
  const projects = projectViews();
  const ids = ensureOrder(state.sidebarOrder.projects, projects, (project) => project.id);
  state.sidebarOrder.projects = moveId(ids, id, targetId, after); saveSidebarOrder(); renderSessions();
}
function reorderChats(key, id, targetId, after = false) {
  const chats = state.sessions.filter((item) => chatGroupKey(projectForSession(item)) === key);
  const ids = ensureOrder(state.sidebarOrder.chats[key] || [], orderedChats(chats, key), (chat) => chat.sessionId);
  state.sidebarOrder.chats[key] = moveId(ids, id, targetId, after); saveSidebarOrder(); renderSessions();
}
function addReorderHandle(parent, { label, ids, id, onChange }) {
  const handle = document.createElement("button"); handle.type = "button"; handle.className = "reorder-handle";
  handle.textContent = "⠿"; handle.title = `Drag to reorder ${label}. Use Option + ↑ or ↓ for keyboard reordering.`;
  handle.setAttribute("aria-label", handle.title); handle.draggable = true;
  handle.addEventListener("dragstart", (event) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(`application/x-unreal-${label}`, id);
    event.dataTransfer.setData("text/plain", id);
    parent.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => parent.classList.remove("dragging"));
  handle.addEventListener("keydown", (event) => {
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); onChange(moveIdBy(ids(), id, event.key === "ArrowUp" ? -1 : 1));
  });
  parent.prepend(handle);
}
function setProjectExpanded(folderPath, expanded) {
  if (expanded) state.expandedProjectPaths.add(folderPath);
  else state.expandedProjectPaths.delete(folderPath);
  try { localStorage.setItem("unreal-console-expanded-projects", JSON.stringify([...state.expandedProjectPaths])); } catch {}
}
function loadExpandedProjects() {
  try {
    const paths = JSON.parse(localStorage.getItem("unreal-console-expanded-projects") || "[]");
    if (Array.isArray(paths)) state.expandedProjectPaths = new Set(paths.filter((item) => typeof item === "string"));
  } catch { state.expandedProjectPaths = new Set(); }
}

function projectForSession(item) {
  // The dedicated one-off workspace sits inside the user's home directory on
  // macOS. Keep it projectless even when the home folder itself is a project.
  if (state.oneOffWorkspacePath && pathContains(state.oneOffWorkspacePath, item.cwd)) return null;
  return projectViews().filter((project) => {
    const root = project.path.replace(/\/+$/, "") || "/";
    return item.cwd === root || item.cwd?.startsWith(root === "/" ? "/" : `${root}/`);
  }).sort((a, b) => b.path.length - a.path.length)[0] || null;
}

function selectProject(folderPath) {
  const project = projectViews().find((item) => item.path === folderPath);
  if (!project) return;
  setProjectExpanded(folderPath, true);
  if (state.currentProjectPath === folderPath && !state.currentId) { renderSessions(); return; }
  closeControlPopover();
  cacheCurrentTranscript();
  state.currentProjectPath = folderPath; state.currentId = null;
  try { localStorage.setItem("unreal-console-project", folderPath); } catch {}
  state.stream?.close(); state.stream = null;
  state.resolveConfigReady?.(null); state.resolveConfigReady = null; clearTimeout(state.configReadyTimeout);
  state.configReadyTimeout = null; state.configReady = null;
  ui.prompt.value = ""; ui.prompt.disabled = false; ui.prompt.style.height = "auto";
  state.attachments = []; renderAttachments();
  $("#attachImage").disabled = false;
  for (const control of ["#modelControl", "#permissionControl", "#reasoningControl", "#usageControl", "#mobileControls"]) $(control).disabled = false;
  $("#moreActions").disabled = true;
  state.currentProvider = null; state.subscriptionBaseline = null; state.usageReference = null; resetUsage();
  ui.sidebar.classList.remove("open");
  ui.taskTitle.textContent = project.name; ui.taskPath.textContent = project.path;
  ui.composerContext.textContent = "Write a message to start a new chat";
  $("#welcomeTitle").textContent = project.name;
  $("#welcomeCopy").hidden = true;
  const starter = $("#starterNewChat");
  starter.querySelector("strong").textContent = "Start a chat";
  starter.querySelector("small").textContent = `Work in ${project.name}`;
  setConnection(state.ready, state.ready ? "Project selected" : "Hydra unavailable");
  resetTranscript(); renderSessions();
}

function renderSessions() {
  ui.sessionList.replaceChildren();
  const projects = projectViews();
  ui.sessionCount.textContent = projects.length ? String(projects.length) : "";
  if (!projects.length && !state.sessions.length) {
    const empty = document.createElement("p"); empty.className = "sidebar-empty"; empty.textContent = "Add a folder to create your first project";
    ui.sessionList.append(empty); return;
  }
  const appendChat = (parent, item, groupKey, groupChats) => {
    const chatRow = document.createElement("div"); chatRow.className = "chat-row";
    chatRow.dataset.reorderId = item.sessionId;
    chatRow.addEventListener("dragover", (event) => { if (event.dataTransfer.types.includes("application/x-unreal-chat")) { event.preventDefault(); chatRow.classList.add("drag-over"); } });
    chatRow.addEventListener("dragleave", () => chatRow.classList.remove("drag-over"));
    chatRow.addEventListener("drop", (event) => { event.preventDefault(); chatRow.classList.remove("drag-over"); const id = event.dataTransfer.getData("application/x-unreal-chat"); if (groupChats.some((chat) => chat.sessionId === id) && id !== item.sessionId) reorderChats(groupKey, id, item.sessionId); });
    const button = document.createElement("button"); button.type = "button";
    button.className = `session-item${item.sessionId === state.currentId ? " active" : ""}`;
    const indicator = document.createElement("span"); indicator.className = `session-state ${sessionState(item)}`;
    const details = document.createElement("span"); details.className = "session-copy";
    const name = document.createElement("strong"); name.textContent = item.title || "Untitled chat";
    const metaLine = document.createElement("small");
    const time = document.createElement("span"); time.textContent = relativeTime(item.updatedAt);
    const model = document.createElement("span"); model.textContent = displayModel(item.currentModel);
    metaLine.append(time, model); details.append(name, metaLine); button.append(indicator, details);
    button.addEventListener("click", () => selectSession(item.sessionId));

    const remove = document.createElement("button"); remove.type = "button"; remove.className = "chat-delete";
    remove.title = "Delete chat";
    remove.setAttribute("aria-label", `Delete chat: ${item.title || "Untitled chat"}`);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true"); icon.setAttribute("focusable", "false");
    const outline = document.createElementNS("http://www.w3.org/2000/svg", "path");
    outline.setAttribute("d", "M3 6h18M8 6V4h8v2m-11 0 1 14h12l1-14M10 11v5m4-5v5");
    icon.append(outline); remove.append(icon);
    remove.addEventListener("click", () => openDeleteChat(item));
    chatRow.append(button, remove);
    addReorderHandle(chatRow, { label: "chat", id: item.sessionId,
      ids: () => ensureOrder(state.sidebarOrder.chats[groupKey] || [], groupChats, (chat) => chat.sessionId),
      onChange: (ids) => { state.sidebarOrder.chats[groupKey] = ids; saveSidebarOrder(); renderSessions(); }
    });
    parent.append(chatRow);
  };

  for (const project of projects) {
    const groupKey = chatGroupKey(project);
    const chats = orderedChats(state.sessions.filter((item) => projectForSession(item)?.path === project.path), groupKey);
    const expanded = state.expandedProjectPaths.has(project.path);
    const group = document.createElement("section"); group.className = "project-group";
    group.addEventListener("dragover", (event) => {
      if (event.dataTransfer.types.includes("application/x-unreal-project")) { event.preventDefault(); row.classList.add("drag-over"); }
    });
    group.addEventListener("dragleave", (event) => { if (!group.contains(event.relatedTarget)) row.classList.remove("drag-over"); });
    group.addEventListener("drop", (event) => {
      row.classList.remove("drag-over");
      const id = event.dataTransfer.getData("application/x-unreal-project");
      if (projects.some((item) => item.id === id) && id !== project.id) { event.preventDefault(); reorderProjects(id, project.id); }
    });
    const row = document.createElement("div"); row.className = `project-row${project.path === state.currentProjectPath ? " active" : ""}`;
    addReorderHandle(row, { label: "project", id: project.id,
      ids: () => ensureOrder(state.sidebarOrder.projects, projects, (item) => item.id),
      onChange: (ids) => { state.sidebarOrder.projects = ids; saveSidebarOrder(); renderSessions(); }
    });
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "project-toggle";
    toggle.textContent = expanded ? "⌄" : "›"; toggle.title = `${expanded ? "Hide" : "Show"} chats in ${project.name}`;
    toggle.setAttribute("aria-label", toggle.title); toggle.setAttribute("aria-expanded", String(expanded));
    toggle.addEventListener("click", () => { setProjectExpanded(project.path, !expanded); renderSessions(); });

    const select = document.createElement("button"); select.type = "button"; select.className = "project-select";
    select.setAttribute("aria-label", `Open project ${project.name}`);
    const glyph = document.createElement("span"); glyph.className = "project-glyph"; glyph.textContent = "▰";
    const copy = document.createElement("span"); copy.className = "project-copy";
    const title = document.createElement("strong"); title.textContent = project.name;
    const meta = document.createElement("small"); meta.textContent = project.path;
    copy.append(title, meta); select.append(glyph, copy);
    select.addEventListener("click", () => selectProject(project.path));
    row.append(toggle, select);

    const addChat = document.createElement("button"); addChat.type = "button"; addChat.className = "project-add-chat";
    addChat.textContent = "+"; addChat.title = `New chat in ${project.name}`; addChat.setAttribute("aria-label", addChat.title);
    addChat.addEventListener("click", () => { selectProject(project.path); void startNewChat(project.path); });
    row.append(addChat);
    const manage = document.createElement("button"); manage.type = "button"; manage.className = "project-manage";
    manage.textContent = "⋯"; manage.title = project.saved ? `Edit or delete ${project.name}` : `Edit ${project.name}`; manage.setAttribute("aria-label", manage.title);
    manage.addEventListener("click", () => openProjectDialog(project)); row.append(manage);
    group.append(row);
    if (expanded) {
      const chatsList = document.createElement("div"); chatsList.className = "project-chats";
      if (!chats.length) {
        const none = document.createElement("p"); none.className = "project-no-chats"; none.textContent = "No chats yet"; chatsList.append(none);
      }
      for (const item of chats) appendChat(chatsList, item, groupKey, chats);
      group.append(chatsList);
    }
    ui.sessionList.append(group);
  }

  const unassigned = orderedChats(state.sessions.filter((item) => !projectForSession(item)), "one-off");
  if (unassigned.length) {
    const group = document.createElement("section"); group.className = "project-group unassigned-group";
    const heading = document.createElement("div"); heading.className = "unassigned-heading"; heading.textContent = "One-off chats";
    group.append(heading);
    for (const item of unassigned) appendChat(group, item, "one-off", unassigned);
    ui.sessionList.append(group);
  }
}

function openProjectDialog(project = null) {
  const editing = Boolean(project);
  state.editingProjectId = project?.saved && project.id ? project.id : null;
  state.editingProjectPath = editing ? project.path : null;
  state.editingLegacyProject = Boolean(project && !project.saved);
  $("#projectDialogEyebrow").textContent = editing ? "EDIT PROJECT" : "NEW PROJECT";
  $("#projectDialogTitle").textContent = editing ? "Edit project" : "Add a project folder";
  $("#projectNameField").hidden = !editing;
  $("#projectPathField").hidden = false;
  $("#projectName").value = editing ? project.name : "";
  $("#projectName").required = editing;
  $("#projectPath").value = editing ? project.path : "";
  $("#projectPath").readOnly = false;
  $("#browseFolder").hidden = false;
  $("#deleteProject").hidden = !project?.saved;
  $("#projectDialogNote").textContent = editing
    ? state.editingLegacyProject
      ? "This workspace was discovered from existing chats. Saving it makes it a regular project that you can rename or remove later."
      : "New chats will use this folder. This does not move files or existing chats; they remain linked to their original folder."
    : "The folder is used as the workspace source for chats in this project. Existing chats in that folder will appear here too.";
  $("#saveProject").textContent = editing ? "Save changes" : "Add project";
  ui.projectDialog.showModal();
  setTimeout(() => (editing ? $("#projectName") : $("#projectPath")).focus(), 50);
}

function openDeleteProject(project) {
  state.pendingProjectId = project.id;
  $("#deleteProjectTitle").textContent = `Delete “${project.name}”?`;
  $("#deleteProjectCopy").textContent = "This removes the project from the sidebar. Its folder, files, and chat history will not be deleted; existing chats will move to Unassigned chats.";
  ui.projectDialog.close();
  $("#confirmDeleteProject").disabled = false;
  $("#confirmDeleteProject").textContent = "Delete project";
  ui.deleteProjectDialog.showModal();
}

async function deleteSelectedProject() {
  const project = state.projects.find((item) => item.id === state.pendingProjectId);
  if (!project || state.deletingProject) return;
  const button = $("#confirmDeleteProject");
  state.deletingProject = true; button.disabled = true; button.textContent = "Deleting…";
  try {
    const result = await requestJson(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    state.projects = state.projects.filter((item) => item.id !== project.id);
    state.removedProjectPaths = result.removedProjectPaths || [...state.removedProjectPaths, project.path];
    state.expandedProjectPaths.delete(project.path);
    try { localStorage.setItem("unreal-console-expanded-projects", JSON.stringify([...state.expandedProjectPaths])); } catch {}
    ui.deleteProjectDialog.close(); state.pendingProjectId = null;
    if (state.currentProjectPath === project.path) {
      state.currentProjectPath = null;
      if (!state.currentId) {
        const next = projectViews()[0];
        if (next) selectProject(next.path); else showNoProject();
      }
    }
    renderSessions();
    showToast(`Deleted project “${project.name}”`);
  } catch (error) {
    showToast(`Could not delete project: ${error.message}`);
  } finally {
    state.deletingProject = false;
    if (ui.deleteProjectDialog.open) { button.disabled = false; button.textContent = "Delete project"; }
  }
}

function openDeleteChat(item) {
  state.pendingDeleteId = item.sessionId;
  const title = item.title || "Untitled chat";
  ui.deleteChatTitle.textContent = `Delete “${title}”?`;
  ui.deleteChatCopy.textContent = `This permanently deletes the conversation and its history. Your project files will not be changed.${item.busy ? " The active task will be stopped." : ""}`;
  ui.confirmDeleteChat.disabled = false;
  ui.confirmDeleteChat.textContent = "Delete chat";
  ui.deleteChatDialog.showModal();
}

function showNoProject() {
  closeControlPopover();
  cacheCurrentTranscript();
  state.currentProjectPath = null; state.currentId = null;
  state.stream?.close(); state.stream = null;
  state.resolveConfigReady?.(null); state.resolveConfigReady = null; clearTimeout(state.configReadyTimeout);
  state.configReadyTimeout = null; state.configReady = null;
  ui.prompt.value = ""; ui.prompt.disabled = true; ui.prompt.style.height = "auto";
  state.attachments = []; renderAttachments();
  $("#attachImage").disabled = true;
  for (const control of ["#modelControl", "#permissionControl", "#reasoningControl", "#usageControl", "#mobileControls"]) $(control).disabled = true;
  $("#moreActions").disabled = true;
  state.currentProvider = null; state.subscriptionBaseline = null; state.usageReference = null; resetUsage();
  ui.sidebar.classList.remove("open");
  ui.taskTitle.textContent = "Select a project"; ui.taskPath.textContent = "Add a folder to organize your chats.";
  ui.composerContext.textContent = "Select a task to begin";
  $("#welcomeTitle").innerHTML = "Your work,<br /><em>without the clutter.</em>";
  $("#welcomeCopy").textContent = "Add a project folder to get started. Each project keeps its chats together.";
  $("#welcomeCopy").hidden = false;
  const starter = $("#starterNewChat");
  starter.querySelector("strong").textContent = "Start a chat";
  starter.querySelector("small").textContent = "Work in the selected project";
  setConnection(state.ready, state.ready ? "Hydra connected" : "Hydra unavailable");
  resetTranscript(); renderSessions();
}

async function deleteSelectedChat() {
  const id = state.pendingDeleteId;
  if (!id || state.deletingChat) return;
  const item = state.sessions.find((session) => session.sessionId === id);
  if (!item) {
    ui.deleteChatDialog.close();
    showToast("This chat is no longer available.");
    return;
  }

  state.deletingChat = true;
  ui.confirmDeleteChat.disabled = true; ui.confirmDeleteChat.textContent = "Deleting…";
  $("#cancelDeleteChat").disabled = true; $("#closeDeleteChatDialog").disabled = true;
  let deleted = false;
  try {
    await requestJson(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    recentTranscripts.delete(id);
    const wasCurrent = state.currentId === id;
    const previousProjectPath = state.currentProjectPath;
    state.sessions = state.sessions.filter((session) => session.sessionId !== id);
    savePendingDrafts();
    deleted = true;
    ui.deleteChatDialog.close();

    const projects = projectViews();
    const currentProjectWasRemoved = previousProjectPath && !projects.some((project) => project.path === previousProjectPath);
    if (wasCurrent || currentProjectWasRemoved) {
      const nextProject = projects.find((project) => project.path === previousProjectPath) || projects[0];
      if (nextProject) {
        state.currentProjectPath = null;
        selectProject(nextProject.path);
      } else {
        showNoProject();
      }
    } else {
      renderSessions();
    }
    showToast(`Deleted “${item.title || "Untitled chat"}”`);
  } catch (error) {
    showToast(`Could not delete chat: ${error.message}`);
  } finally {
    state.deletingChat = false;
    if (deleted) state.pendingDeleteId = null;
    if (ui.deleteChatDialog.open) {
      ui.confirmDeleteChat.disabled = false; ui.confirmDeleteChat.textContent = "Delete chat";
      $("#cancelDeleteChat").disabled = false; $("#closeDeleteChatDialog").disabled = false;
    }
  }
}

let chatSearchTimer;
let chatSearchRequest = 0;
let chatSearchController;
function closeChatSearch() { ui.chatSearchDialog.close(); }
function openChatSearch() {
  if (!ui.chatSearchDialog.open) {
    ui.chatSearchDialog.showModal();
    if (ui.chatSearchInput.value.trim()) void runChatSearch();
  }
  ui.chatSearchInput.focus();
  ui.chatSearchInput.select();
}
async function runChatSearch() {
  const query = ui.chatSearchInput.value.trim();
  const requestId = ++chatSearchRequest;
  chatSearchController?.abort();
  ui.chatSearchResults.replaceChildren();
  if (!query) { ui.chatSearchStatus.textContent = "Type to search your chats."; return; }
  ui.chatSearchStatus.textContent = "Searching…";
  const controller = new AbortController();
  chatSearchController = controller;
  try {
    const response = await requestJson(`/api/chat-search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
    if (requestId !== chatSearchRequest || !ui.chatSearchDialog.open) return;
    const results = response.results || [];
    ui.chatSearchStatus.textContent = results.length ? `${results.length} chat${results.length === 1 ? "" : "s"} found${results.length === 50 ? " (first 50)" : ""}` : "No matching chats.";
    for (const result of results) {
      const button = document.createElement("button"); button.type = "button"; button.className = "chat-search-result";
      const title = document.createElement("strong"); title.textContent = result.title;
      const meta = document.createElement("small");
      const project = projectViews().find((item) => result.cwd && pathContains(item.path, result.cwd));
      meta.textContent = `${project?.name || basename(result.cwd)} · ${result.updatedAt ? relativeTime(result.updatedAt) : ""}`;
      button.append(title, meta);
      if (result.snippet) {
        const snippet = document.createElement("span"); snippet.className = "search-snippet";
        snippet.textContent = `${result.role}: ${result.snippet}`; button.append(snippet);
      }
      button.addEventListener("click", () => { closeChatSearch(); selectSession(result.sessionId); });
      ui.chatSearchResults.append(button);
    }
  } catch (error) {
    if (requestId === chatSearchRequest && error.name !== "AbortError") ui.chatSearchStatus.textContent = `Search failed: ${error.message}`;
  }
}

function resetTranscript() {
  state.queuedInputs = [];
  state.deliveryIds = new Set();
  state.entries = []; state.byMessage = new Map(); state.byTool = new Map(); state.configOptions = []; state.running = false; state.promptRequests = 0; state.stopping = false; state.taskError = "";
  state.liveProgress = null; state.progressTurns = []; state.selectedProgressTurn = null; state.expandedProgressTools.clear(); closeProgressPanel();
  state.openActivityGroups = new Set();
  state.openToolCalls = new Set(); state.expandedNotes = new Set();
  renderTranscript();
}

function selectSession(id, initialConfig = []) {
  if (state.currentId === id && state.stream) return;
  const item = state.sessions.find((session) => session.sessionId === id);
  if (!item) { showToast("This chat is not available yet. Refresh the project and try again."); return; }
  closeControlPopover();
  if (state.currentId !== id) cacheCurrentTranscript();
  const cached = recentTranscripts.take(id);
  state.currentId = id;
  scrollFollow.follow();
  const project = projectForSession(item);
  state.currentProjectPath = project?.path || null;
  if (project) setProjectExpanded(project.path, true);
  ui.prompt.value = ""; ui.prompt.style.height = "auto"; state.attachments = []; renderAttachments();
  ui.prompt.disabled = false; $("#attachImage").disabled = false;
  renderSessions();
  ui.taskTitle.textContent = item.title || "Untitled chat"; ui.taskPath.textContent = item.cwd || "Local workspace";
  ui.composer.querySelector(".send-button").disabled = false;
  for (const control of ["#modelControl", "#permissionControl", "#reasoningControl", "#usageControl", "#mobileControls", "#moreActions"]) $(control).disabled = false;
  ui.composerContext.textContent = `${basename(item.cwd)} · ${displayModel(item.currentModel)}`;
  $("#modelLabel").textContent = (item.currentModel || "Model").split("/").pop();
  state.currentProvider = null; state.subscriptionBaseline = null; state.usageReference = null; resetUsage(item.currentUsage);
  ui.sidebar.classList.remove("open");
  resetTranscript();
  if (cached) restoreTranscript(cached);
  else state.configOptions = initialConfig;
  applyConfigLabels();
  connectStream(id);
}

function connectStream(id) {
  state.stream?.close();
  state.resolveConfigReady?.(null);
  clearTimeout(state.configReadyTimeout);
  let resolveConfigReady;
  state.configReady = new Promise((resolve) => { resolveConfigReady = resolve; });
  state.resolveConfigReady = resolveConfigReady;
  state.configReadyTimeout = setTimeout(() => {
    if (state.resolveConfigReady !== resolveConfigReady) return;
    state.resolveConfigReady = null; state.configReadyTimeout = null; resolveConfigReady(null);
  }, 45000);
  const settleConfigReady = (options) => {
    if (state.resolveConfigReady !== resolveConfigReady) return;
    clearTimeout(state.configReadyTimeout); state.configReadyTimeout = null; state.resolveConfigReady = null;
    resolveConfigReady(options);
  };
  setConnection(false, "Opening chat…");
  const stream = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`); state.stream = stream;
  // Attach replays the full history before the ready event. Keep the cached
  // transcript visible while that happens, then replace it atomically with
  // the authoritative replay. Never append replayed chunks to cached text.
  const history = [];
  let attached = false;
  const applyFrame = ({ type, data }) => {
    if (type === "hydra") handleHydra(data);
    else if (type === "permission") addPermission(data);
    else handleConsole(data);
  };
  const queueOrApply = (type, data) => {
    if (state.stream !== stream) return;
    if (!attached) { history.push({ type, data }); return; }
    applyFrame({ type, data });
  };
  stream.addEventListener("ready", (event) => {
    if (state.stream !== stream) return;
    const data = JSON.parse(event.data);
    replayingHistory = true;
    try {
      resetTranscript();
      for (const frame of history) applyFrame(frame);
    } finally { replayingHistory = false; history.length = 0; }
    if (Number.isFinite(data.activePrompts)) {
      state.promptRequests = data.activePrompts; state.running = data.activePrompts > 0;
    }
    state.queuedInputs = data.queuedInputs || [];
    attached = true; state.modelFavorites = data.modelFavorites || [];
    state.progressTurns = (data.turnTimeline || []).map(hydrateProgress).filter(Boolean);
    state.liveProgress = state.progressTurns.at(-1) || null;
    if (state.selectedProgressTurn !== null && state.selectedProgressTurn >= state.progressTurns.length) state.selectedProgressTurn = null;
    state.configOptions = applyModelFavorites(data.configOptions || [], state.modelFavorites);
    const modelDescription = state.configOptions.find((option) => option.id === "model")?.description || "";
    state.currentProvider = data._meta?.["unreal-agent/provider"]
      || (modelDescription.includes("through Claude Code") ? "claude-code"
        : modelDescription.includes("through OpenAI Codex") ? "openai-codex" : null);
    const activeId = id;
    state.subscriptionBaseline = null; state.usageReference = null;
    void refreshThreadUsageDetails(activeId);
    renderUsageLabel(); void refreshSubscriptionUsage(state.currentProvider);
    applyConfigLabels(); setConnection(true, "Live with Hydra"); renderTranscript(); settleConfigReady(state.configOptions);
  });
  stream.addEventListener("hydra", (event) => queueOrApply("hydra", JSON.parse(event.data)));
  stream.addEventListener("permission", (event) => queueOrApply("permission", JSON.parse(event.data)));
  stream.addEventListener("console", (event) => queueOrApply("console", JSON.parse(event.data)));
  stream.addEventListener("fault", (event) => {
    if (state.stream !== stream) return;
    const data = JSON.parse(event.data); finishProgress(state.liveProgress, "interrupted"); showToast(data.error); setConnection(false, "Task unavailable"); renderTranscript(); settleConfigReady(null);
  });
  stream.onerror = () => {
    if (state.stream !== stream) return;
    // EventSource may reconnect the same URL; its new attach replays full history.
    attached = false; history.length = 0;
    setConnection(false, "Reconnecting"); renderTranscript();
  };
}

async function refreshThreadUsageDetails(sessionId) {
  try {
    const details = await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/usage-details`);
    if (state.currentId !== sessionId) return;
    state.subscriptionBaseline = details.baseline?.provider === details.provider ? details.baseline : null;
    state.usageReference = details.reference;
    if (!state.currentProvider && details.provider) state.currentProvider = details.provider;
    const snapshot = details.usage;
    if (snapshot && (snapshot.inputTokens || 0) >= state.usage.inputTokens
      && (snapshot.outputTokens || 0) >= state.usage.outputTokens) resetUsage(snapshot);
    state.subagentUsage = details.subagents || null;
    if (state.usage.size <= 0 && details.reference?.contextWindow) state.usage.size = details.reference.contextWindow;
    renderUsageLabel();
    if (state.openControl === 'usageControl') openUsagePopover($('#usageControl'));
  } catch { /* A missing agent metadata file must not block the conversation. */ }
}

function textFrom(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textFrom).join("");
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (content.content !== undefined) return textFrom(content.content);
  return "";
}

function imagesFrom(content) {
  const result = [];
  const visit = (item) => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!item || typeof item !== "object") return;
    if (item.type === "image") {
      if (typeof item.data === "string" && item.mimeType) result.push({ mimeType: item.mimeType, data: item.data });
      else if (typeof item.uri === "string" && item.uri.startsWith("data:image/")) {
        const match = item.uri.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
        if (match) result.push({ mimeType: match[1], data: match[2] });
      }
      return;
    }
    if (item.content !== undefined) visit(item.content);
  };
  visit(content); return result;
}

function messageEntry(role, id) {
  const key = id || `${role}-${state.entries.length}`;
  let entry = state.byMessage.get(key);
  if (!entry) {
    entry = { type: "message", role, id: key, text: "", images: [] };
    state.byMessage.set(key, entry); state.entries.push(entry);
  }
  return entry;
}

function handleHydra(message) {
  if (message.method !== "session/update") return;
  const deliveryId = message.params?._meta?.["unreal-agent/event-id"];
  state.deliveryIds ||= new Set();
  if (deliveryId && state.deliveryIds.has(deliveryId)) return;
  if (deliveryId) state.deliveryIds.add(deliveryId);
  const update = message.params?.update || {};
  const kind = update.sessionUpdate;
  if (kind === "permission_resolved" && update.toolCallId) {
    state.entries = state.entries.filter((entry) => entry.type !== "permission" || entry.request.toolCall?.toolCallId !== update.toolCallId);
  } else if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
    const role = kind.startsWith("user") ? "user" : "agent";
    const text = textFrom(update.content);
    if (role === "agent" && text && Number.isFinite(message.observedAt)) recordResponse(state.liveProgress, message.observedAt);
    appendMessageChunk(state.entries, state.byMessage, {
      role, id: update.messageId, text, images: imagesFrom(update.content)
    });
  } else if (kind === "agent_thought_chunk") {
    const id = `thought-${update.messageId || "current"}`;
    let entry = state.byMessage.get(id);
    if (!entry) { entry = { type: "thought", id, text: "" }; state.byMessage.set(id, entry); state.entries.push(entry); }
    entry.text += textFrom(update.content);
    if (Number.isFinite(message.observedAt)) recordThought(state.liveProgress, update, message.observedAt);
  } else if ((kind === "tool_call" || kind === "tool_call_update") && isSubagentUpdate(update)) {
    upsertSubagent(state.entries, state.byTool, update);
  } else if (kind === "tool_call") {
    if (Number.isFinite(message.observedAt)) recordTool(state.liveProgress, update, message.observedAt);
    const entry = { type: "tool", id: update.toolCallId, title: update.title || update.kind || "Tool", kind: update.kind, status: update.status || "pending", input: update.rawInput, output: "", delegation: isDelegateCommand(update) };
    state.byTool.set(update.toolCallId, entry); appendToolCall(state.entries, entry);
  } else if (kind === "tool_call_update") {
    if (Number.isFinite(message.observedAt)) recordTool(state.liveProgress, update, message.observedAt);
    let entry = state.byTool.get(update.toolCallId);
    if (!entry) { entry = { type: "tool", id: update.toolCallId, title: "Tool activity", status: "pending", output: "" }; state.byTool.set(update.toolCallId, entry); state.entries.push(entry); }
    entry.status = update.status || entry.status; entry.output = textFrom(update.content) || textFrom(update.rawOutput?.output) || entry.output;
  } else if (kind === "usage_update") {
    updateUsage(update);
  } else if (kind === "config_option_update") {
    if (update.configOptions) state.configOptions = applyModelFavorites(update.configOptions, state.modelFavorites);
    const option = state.configOptions.find((item) => item.id === update.configId);
    if (option) option.currentValue = update.value;
    applyConfigLabels();
  } else if (kind === "session_info_update" && typeof update.title === "string") {
    const session = state.sessions.find((item) => item.sessionId === state.currentId);
    if (session) {
      session.title = update.title;
      renderSessions();
      ui.taskTitle.textContent = update.title;
    }
  } else if (kind === "turn_complete") {
    if (!state.promptRequests) state.running = false;
    state.stopping = false;
    // The turn notification can precede the prompt result (and later tool updates).
    // The request only ends when the Console receives session/prompt's response.
  } else if (kind === "prompt_received") {
    state.running = true;
  }
  renderTranscript();
}

function handleConsole(event) {
  if (event.kind === "queue_changed") {
    state.queuedInputs = event.queuedInputs || [];
    renderQueuedInputs(); return;
  }
  if (event.kind === "queue_error") { showToast(event.error); return; }
  if (event.inputId && ["prompt_complete", "prompt_error"].includes(event.kind)) finishInputId(event.inputId);
  if (event.kind === "permission_answered") {
    state.entries = state.entries.filter((entry) => entry.type !== "permission" || entry.requestId !== event.requestId);
    renderTranscript(); return;
  }
  if (event.kind === "prompt_started") {
    if (!state.promptRequests) {
      state.liveProgress = startProgress(event.startedAt || Date.now());
      state.progressTurns.push(state.liveProgress);
      state.progressTurns = state.progressTurns.slice(-20);
      state.selectedProgressTurn = null;
    }
    state.promptRequests += 1; state.taskError = ""; state.stopping = false;
  }
  else if (event.kind === "prompt_complete") {
    state.promptRequests = Math.max(0, state.promptRequests - 1); state.stopping = false;
    if (!state.promptRequests) finishProgress(state.liveProgress, event.outcome || "completed", event.endedAt ?? Date.now());
    void refreshSubscriptionUsage(state.currentProvider, { fresh: true });
    if (state.currentId) void refreshThreadUsageDetails(state.currentId);
  }
  else if (event.kind === "prompt_error") {
    state.promptRequests = Math.max(0, state.promptRequests - 1); state.stopping = false; state.taskError = event.error || "The task could not finish.";
    if (!state.promptRequests) finishProgress(state.liveProgress, "failed", event.endedAt ?? Date.now());
    showToast(state.taskError);
  }
  state.running = state.promptRequests > 0;
  renderTranscript();
}

function addPermission(data) {
  if (state.entries.some((entry) => entry.type === "permission" && entry.requestId === data.requestId)) return;
  state.entries.push({ type: "permission", requestId: data.requestId, request: data }); renderTranscript();
}

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function toolOutput(entry) {
  if (entry.output) return entry.output;
  if (!entry.input) return "Waiting for output…";
  if (typeof entry.input === "string") return entry.input;
  return entry.input.command || JSON.stringify(entry.input, null, 2);
}


function renderLiveProgress() {
  const panel = ui.liveProgressPanel;
  if (panel.hidden) return;
  const empty = !state.progressTurns.length;
  panel.querySelector(".progress-no-turns").hidden = !empty;
  panel.querySelector(".progress-board").hidden = empty;
  panel.querySelector(".progress-turn-select").hidden = empty;
  panel.querySelector(".progress-heading label").hidden = empty;
  panel.querySelector(".progress-clock").hidden = empty;
  if (empty) return;
  const index = state.selectedProgressTurn ?? state.progressTurns.length - 1;
  const progress = state.progressTurns[index];
  if (!progress) return;
  const snapshot = progressSnapshot(progress);
  const { elapsed, startedAt, endedAt, responseAt, tools, outcome } = snapshot;
  const seconds = Math.ceil(elapsed / 1000);
  const formatTime = (value) => `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  const formatOffset = (at) => {
    const hundredths = Math.max(0, Math.round((at - startedAt) / 10));
    return `${Math.floor(hundredths / 6000)}:${String(Math.floor(hundredths / 100) % 60).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}`;
  };
  panel.querySelector(".progress-clock").textContent = `${formatOffset(startedAt + elapsed)} elapsed`;
  const selector = panel.querySelector(".progress-turn-select");
  if (selector.options.length !== state.progressTurns.length) {
    selector.replaceChildren();
    state.progressTurns.forEach((turn, i) => {
      const option = document.createElement("option"); option.value = String(i);
      option.textContent = `Turn ${i + 1}${turn.endedAt === null ? " · live" : ""} · ${new Date(turn.startedAt).toLocaleString()}`;
      selector.append(option);
    });
  }
  state.progressTurns.forEach((turn, i) => {
    selector.options[i].textContent = `Turn ${i + 1}${turn.endedAt === null ? " · live" : ""} · ${new Date(turn.startedAt).toLocaleString()}`;
  });
  selector.value = String(index);
  panel.querySelector(".progress-turn-label").textContent = `Turn ${index + 1}`;
  panel.querySelector(".progress-outcome").textContent = outcome ? outcome === "completed" ? "Completed" : outcome === "failed" ? "Failed" : "Interrupted" : "Active";
  // The request includes tool time, so call it a Turn rather than implying the model
  // was continuously computing. The response marker is the last observed text chunk.
  const turnRow = { id: "agent-request", title: "Turn", status: outcome || "running", left: 0, width: 100, endedAt };
  const responseRow = responseAt === null ? null : { id: "response-text", title: "Response", status: "received",
    left: Math.max(0, Math.min(100, (responseAt - startedAt) / elapsed * 100)), width: 0, endedAt: responseAt };
  const lanes = panel.querySelector(".progress-lanes");
  const focusedTool = panel.contains(document.activeElement) ? document.activeElement?.dataset?.progressToolKey : null;
  lanes.replaceChildren();
  function appendLane(row) {
    const lane = document.createElement("div"); lane.className = "progress-lane";
    const dot = document.createElement("span"); dot.className = `progress-dot ${row.status}`; dot.setAttribute("aria-hidden", "true");
    const isTool = row.id !== "agent-request" && row.id !== "response-text";
    const toolKey = isTool ? `${index}:${row.id}` : null;
    const expanded = isTool && state.expandedProgressTools.has(toolKey);
    const label = document.createElement(isTool ? "button" : "span"); label.className = "progress-label";
    label.textContent = isTool ? timelineToolLabel(row.title) : row.title;
    if (isTool) {
      lane.classList.add("progress-tool"); label.type = "button";
      label.dataset.progressToolKey = toolKey;
      label.setAttribute("aria-expanded", String(expanded));
      label.setAttribute("aria-controls", `progress-tool-detail-${index}-${tools.indexOf(row)}`);
      label.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} details for ${label.textContent}: ${row.title}`);
      label.addEventListener("click", () => {
        if (expanded) state.expandedProgressTools.delete(toolKey);
        else state.expandedProgressTools.add(toolKey);
        renderLiveProgress();
      });
    }
    label.title = row.id === "response-text" ? "Last assistant text observed" : row.id === "agent-request" ? "Request from send to prompt result, including tool time" : row.title;
    const status = document.createElement("span"); status.className = "progress-status";
    const statusName = row.status === "running" ? "Running" : row.status === "received" ? "Text seen" : row.status === "completed" ? "Completed" : row.status === "failed" ? "Failed" : row.status === "interrupted" ? "Interrupted" : "Returned";
    status.textContent = statusName;
    if (row.endedAt !== null) {
      const time = document.createElement("small"); time.textContent = formatOffset(row.endedAt);
      status.append(time);
    }
    const track = document.createElement("span"); track.className = "progress-track";
    const offset = row.endedAt === null ? formatOffset(startedAt + elapsed) : formatOffset(row.endedAt);
    track.setAttribute("aria-label", `${row.title}: ${statusName} at ${offset} after send`);
    track.title = `${row.title}: ${statusName} at ${offset} after send${row.endedAt === null ? "" : ` (${new Date(row.endedAt).toLocaleString()})`}`;
    const bar = document.createElement("span"); bar.className = `progress-bar ${row.status}`;
    bar.style.left = `${row.left}%`; bar.style.width = `${row.width}%`;
    track.append(bar);
    if (lane.classList.contains("progress-tool")) {
      const icon = document.createElement("span"); icon.className = "progress-tool-icon"; icon.textContent = "›_"; icon.setAttribute("aria-hidden", "true");
      lane.append(icon, label, status, track);
    } else lane.append(dot, label, status, track);
    lanes.append(lane);
    if (expanded) {
      const detail = document.createElement("div"); detail.className = "progress-tool-detail";
      detail.id = `progress-tool-detail-${index}-${tools.indexOf(row)}`;
      const heading = document.createElement("strong"); heading.textContent = "Tool call";
      const command = document.createElement("pre"); command.textContent = row.title;
      detail.append(heading, command); lanes.append(detail);
    }
  }
  appendLane(turnRow);
  for (const group of progressGroups(snapshot)) {
    const heading = document.createElement("div"); heading.className = "progress-step";
    const caption = document.createElement("strong"); caption.textContent = group.step ? "Reasoning" : snapshot.steps.length ? "Before reasoning" : "Tools";
    const summary = document.createElement("p"); summary.textContent = group.step ? timelineReasoningText(group.step.text) : "No reasoning summary observed for these tools.";
    heading.append(caption, summary); lanes.append(heading);
    for (const tool of group.tools) appendLane(tool);
  }
  if (responseRow) appendLane(responseRow);
  if (focusedTool) {
    const nextFocus = [...lanes.querySelectorAll("[data-progress-tool-key]")].find((button) => button.dataset.progressToolKey === focusedTool);
    nextFocus?.focus({ preventScroll: true });
  }
  const axis = panel.querySelector(".progress-axis"); axis.replaceChildren();
  for (let i = 0; i <= 4; i += 1) {
    const tick = document.createElement("span"); tick.textContent = formatTime(Math.round(seconds * i / 4)); axis.append(tick);
  }
  panel.querySelector(".progress-empty").hidden = tools.length > 0;
}

function closeProgressPanel() {
  ui.liveProgressPanel.hidden = true;
  ui.liveState.setAttribute("aria-expanded", "false");
  ui.timelineButton.setAttribute("aria-expanded", "false");
}

function toggleProgressPanel() {
  if (!state.currentId) return;
  if (!ui.liveProgressPanel.hidden) return closeProgressPanel();
  closeControlPopover(); commandPanel?.close();
  ui.liveProgressPanel.hidden = false;
  ui.liveState.setAttribute("aria-expanded", "true");
  ui.timelineButton.setAttribute("aria-expanded", "true");
  renderLiveProgress();
}

function renderAttachments() {
  ui.attachmentList.replaceChildren();
  ui.attachmentList.hidden = state.attachments.length === 0;
  state.attachments.forEach((image, index) => {
    const card = document.createElement("div"); card.className = "attachment-preview";
    const img = document.createElement("img"); img.src = `data:${image.mimeType};base64,${image.data}`; img.alt = image.name;
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${image.name}`);
    remove.addEventListener("click", () => { state.attachments.splice(index, 1); renderAttachments(); updateSendAvailability(); });
    card.append(img, remove); ui.attachmentList.append(card);
  });
  updateSendAvailability();
}

function updateSendAvailability() {
  const button = ui.composer.querySelector(".send-button");
  button.disabled = (!state.currentId && !state.currentProjectPath) || state.creatingChat || state.submitting || (!ui.prompt.value.trim() && !state.attachments.length);
}

async function addImageFiles(files) {
  const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  for (const file of files) {
    if (!allowed.has(file.type)) { showToast(`${file.name || "File"}: use PNG, JPEG, GIF, or WebP images.`); continue; }
    if (file.size > 3 * 1024 * 1024) { showToast(`${file.name}: images must be 3 MB or smaller.`); continue; }
    if (state.attachments.length >= 4) { showToast("Attach up to 4 images per message."); break; }
    if (state.attachments.reduce((sum, image) => sum + Math.floor(image.data.length * 3 / 4), 0) + file.size > 12 * 1024 * 1024) {
      showToast("Images must total 12 MB or less."); break;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    state.attachments.push({ name: file.name || "Image", mimeType: file.type, data: btoa(binary) });
  }
  renderAttachments();
}

function renderQueuedInputs() {
  ui.followupQueue.replaceChildren();
  ui.followupQueue.hidden = !state.queuedInputs.length;
  if (!state.queuedInputs.length) return;
  const heading = document.createElement("div"); heading.className = "queue-heading";
  heading.textContent = `${state.queuedInputs.length} queued · ${state.running ? "runs after the current task" : "choose Send now to continue"}`;
  ui.followupQueue.append(heading);
  for (const input of state.queuedInputs) {
    const card = document.createElement("div"); card.className = "queued-input";
    const preview = document.createElement("span"); preview.className = "queued-input-text";
    const imageCount = input.attachments?.length || 0;
    preview.textContent = input.text || `${imageCount} attached image${imageCount === 1 ? "" : "s"}`;
    if (input.text && imageCount) preview.textContent += ` · ${imageCount} image${imageCount === 1 ? "" : "s"}`;
    preview.title = preview.textContent;
    const actions = document.createElement("div"); actions.className = "queued-input-actions";
    const steer = document.createElement("button"); steer.type = "button";
    steer.textContent = state.running ? "Steer now" : "Send now";
    steer.title = state.running ? "Redirect the active task with this message" : "Run this queued message now";
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove queued message");
    const sendAction = async (action) => {
      const sessionId = state.currentId;
      steer.disabled = true; remove.disabled = true;
      try {
        await requestJson(`/api/sessions/${sessionId}/${action}`, { method: "POST", body: JSON.stringify({ inputId: input.inputId }) });
      } catch (error) { showToast(error.message); }
      finally { if (state.currentId === sessionId) renderQueuedInputs(); }
    };
    steer.addEventListener("click", () => { void sendAction("steer"); });
    remove.addEventListener("click", () => { void sendAction("remove-queued"); });
    actions.append(steer, remove); card.append(preview, actions); ui.followupQueue.append(card);
  }
}

function renderTranscript() {
  if (replayingHistory) return;
  renderQueuedInputs();
  renderApprovalPanel($("#approvalPanel"), state.entries, answerPermission, showToast);
  const savedScroll = scrollFollow.beforeRender();
  ui.messages.replaceChildren();
  const visible = groupTranscriptEntries(state.entries, state.prefs.showThoughts);
  const status = renderTaskStatus();
  const showStatus = Boolean(state.currentId) && (state.running || status.kind === "approval" || status.kind === "error" || status.kind === "connecting");
  ui.emptyState.hidden = visible.length > 0 || showStatus;
  ui.messages.hidden = visible.length === 0 && !showStatus;
  for (const entry of visible) {
    if (entry.type === "message") {
      const article = document.createElement("article"); article.className = `turn ${entry.role}${entry.interim ? " interim" : ""}`;
      article.setAttribute("aria-label", entry.role === "user" ? "You" : brand().name);
      article.innerHTML = `<div class="turn-body"><div class="message-content">${renderMarkdown(entry.text)}</div></div>`;
      if (entry.images?.length) {
        const images = document.createElement("div"); images.className = "turn-images";
        for (const image of entry.images) {
          const img = document.createElement("img"); img.alt = "Attached image";
          img.src = `data:${image.mimeType};base64,${image.data}`; images.append(img);
        }
        article.querySelector(".turn-body").append(images);
      }
      if (entry.interim) {
        // Progress notes stay short; click to read one in full.
        article.title = "Progress update · click to expand";
        article.classList.toggle("expanded", state.expandedNotes.has(entry.id));
        article.addEventListener("click", () => {
          if (state.expandedNotes.has(entry.id)) state.expandedNotes.delete(entry.id); else state.expandedNotes.add(entry.id);
          article.classList.toggle("expanded", state.expandedNotes.has(entry.id));
        });
      } else if (entry.text) {
        const copy = document.createElement("button");
        copy.type = "button"; copy.className = "message-copy";
        copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect class="copy-glyph" x="8" y="8" width="12" height="12" rx="2"/><path class="copy-glyph" d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/><path class="copied-glyph" d="m5 12 4 4 10-10"/></svg>';
        copy.title = "Copy message with formatting";
        copy.setAttribute("aria-label", "Copy message with formatting");
        copy.addEventListener("click", async () => {
          try {
            await copyMessage(entry.text);
            copy.classList.add("copied");
            copy.title = "Message copied";
            copy.setAttribute("aria-label", "Message copied");
          } catch { showToast("Could not copy message. Check clipboard access."); }
        });
        article.append(copy);
      }
      ui.messages.append(article);
    } else if (entry.type === "subagents") {
      const swarmId = entry.swarm?.id;
      ui.messages.append(renderSubagentGroup(entry, (item) => ({ open: state.openToolCalls.has(item.id),
        onToggle: (open) => { if (open) state.openToolCalls.add(item.id); else state.openToolCalls.delete(item.id); } }),
      // The discussion starts open; closing it is remembered like a card.
      { open: !state.openToolCalls.has(`closed-${swarmId}`),
        onToggle: (open) => { if (open) state.openToolCalls.delete(`closed-${swarmId}`); else state.openToolCalls.add(`closed-${swarmId}`); } }));
    } else if (entry.type === "activity") {
      const toolEntries = entry.entries.filter((item) => item.type === "tool");
      const runningCount = toolEntries.filter((item) => item.status === "pending" || item.status === "in_progress").length;
      const activity = document.createElement("details"); activity.className = "tool-activity";
      activity.open = state.openActivityGroups.has(entry.id);
      const summary = document.createElement("summary");
      const icon = document.createElement("span"); icon.className = "event-icon"; icon.textContent = toolEntries.length ? "›_" : "◇";
      const label = document.createElement("span"); label.className = "event-title";
      label.textContent = activitySummary(entry.entries);
      const status = document.createElement("span");
      const failedCount = toolEntries.filter((item) => item.status === "failed").length;
      status.className = `event-status${runningCount ? " running" : failedCount ? " failed" : " completed"}`;
      status.textContent = runningCount ? `${runningCount} running` : failedCount ? `${failedCount} failed` : "";
      const chevron = document.createElement("span"); chevron.className = "activity-chevron"; chevron.textContent = "›";
      summary.append(icon, label, status, chevron);
      const list = document.createElement("div"); list.className = "tool-activity-list";
      for (const item of entry.entries) {
        if (item.type === "thought") {
          const thought = document.createElement("div"); thought.className = "activity-thought";
          thought.innerHTML = `<strong>Reasoning</strong><div class="activity-thought-content">${renderMarkdown(item.text)}</div>`;
          list.append(thought);
        } else {
          const toolCard = document.createElement("details"); toolCard.className = "event-card";
          toolCard.open = state.openToolCalls.has(item.id);
          const toolStatus = item.status === "pending" || item.status === "in_progress" ? "running" : item.status;
          toolCard.innerHTML = `<summary class="event-card-header"><span class="event-icon">${item.kind === "edit" ? "✎" : "›_"}</span><span class="event-title">${escapeHtml(item.title)}</span><span class="event-status ${escapeHtml(toolStatus)}">${escapeHtml(toolStatus)}</span><span class="tool-chevron" aria-hidden="true">›</span></summary><pre class="event-output">${escapeHtml(toolOutput(item))}</pre>`;
          toolCard.addEventListener("toggle", () => {
            if (toolCard.open) state.openToolCalls.add(item.id);
            else state.openToolCalls.delete(item.id);
          });
          list.append(toolCard);
        }
      }
      activity.append(summary, list);
      activity.addEventListener("toggle", () => {
        if (activity.open) state.openActivityGroups.add(entry.id);
        else state.openActivityGroups.delete(entry.id);
      });
      ui.messages.append(activity);

    }
  }
  if (showStatus) {
    const run = document.createElement("div"); run.className = `run-state ${status.kind}`;
    const icon = document.createElement("i"); icon.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span"); copy.textContent = status.label;
    run.append(icon, copy);
    if (status.detail) { const detail = document.createElement("small"); detail.textContent = status.detail; run.append(detail); }
    ui.messages.append(run);
  }
  const sendButton = ui.composer.querySelector(".send-button");
  sendButton.textContent = "↑";
  sendButton.setAttribute("aria-label", state.running ? "Steer the running task" : "Send");
  sendButton.title = state.running ? "Send to the running task now (Option+Enter queues it for after)" : "Send message";
  ui.stopTask.hidden = !state.running;
  updateSendAvailability();
  renderLiveProgress();
  scrollFollow.afterRender(savedScroll);
  if (!scrollFollow.following && state.running) ui.jumpLatest.hidden = false;
}

async function answerPermission(entry, optionId) {
  const sessionId = state.currentId;
  await requestJson(`/api/sessions/${sessionId}/permission`, { method: "POST", body: JSON.stringify({ requestId: entry.requestId, optionId }) });
  if (state.currentId === sessionId) {
    state.entries = state.entries.filter((item) => item.requestId !== entry.requestId);
    renderTranscript();
  }
}

function config(idPart) { return state.configOptions.find((item) => item.id === idPart || item.id?.includes(idPart)); }
function displayValue(option) {
  if (!option) return null;
  const selected = (option.options || []).find((item) => (item.value ?? item.id) === option.currentValue);
  return selected?.name || selected?.label || String(option.currentValue || "");
}
function modelControlLabel(option) {
  return displayValue(option)
    .replace(/^★\s*/, "")
    .replace(/\s+·\s+(?=(?:<)?\$)[\s\S]*$/, "");
}
function applyConfigLabels() {
  const model = config("model"), permission = config("permission"), thought = config("thought");
  $("#modelLabel").textContent = model ? modelControlLabel(model) || "Model" : "Loading model…";
  $("#permissionLabel").textContent = permission ? displayValue(permission) || "Workspace" : "Workspace";
  $("#reasoningLabel").textContent = thought ? displayValue(thought) || "High" : "Loading…";
  $("#mobileModelLabel").textContent = $("#modelLabel").textContent;
  $("#mobileReasoningLabel").textContent = $("#reasoningLabel").textContent;
}

function closeControlPopover() {
  if (ui.controlPopover.hidden) return;
  ui.controlPopover.hidden = true;
  ui.controlPopover.replaceChildren();
  ui.controlPopover.style.removeProperty('left');
  for (const id of ['modelControl', 'permissionControl', 'reasoningControl', 'usageControl', 'mobileControls']) {
    document.getElementById(id).setAttribute('aria-expanded', 'false');
  }
  state.openControl = null;
}

function showControlPopover(anchor, title, eyebrow) {
  closeControlPopover();
  const popover = ui.controlPopover;
  popover.hidden = false;
  popover.setAttribute('aria-label', title);
  state.openControl = anchor.id;
  anchor.setAttribute('aria-expanded', 'true');
  if (window.matchMedia('(max-width: 760px)').matches) $('#mobileControls').setAttribute('aria-expanded', 'true');
  const heading = document.createElement('div'); heading.className = 'control-popover-heading';
  const copy = document.createElement('div');
  const label = document.createElement('span'); label.textContent = eyebrow;
  const titleNode = document.createElement('strong'); titleNode.textContent = title;
  copy.append(label, titleNode);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'popover-close';
  close.textContent = '×'; close.setAttribute('aria-label', 'Close menu'); close.addEventListener('click', closeControlPopover);
  heading.append(copy, close); popover.append(heading);
  requestAnimationFrame(() => {
    if (popover.hidden) return;
    const anchorRect = anchor.getBoundingClientRect();
    const stripRect = ui.controlStrip.getBoundingClientRect();
    const width = popover.getBoundingClientRect().width;
    const left = Math.max(0, Math.min(anchorRect.left - stripRect.left, ui.controlStrip.clientWidth - width));
    popover.style.left = `${left}px`;
    if (window.matchMedia('(max-width: 760px)').matches && state.openControl === anchor.id) close.focus();
  });
  return popover;
}

function openMobileControls() {
  const anchor = $('#mobileControls');
  if (state.openControl) return closeControlPopover();
  const popover = showControlPopover(anchor, 'Chat settings', 'THIS CHAT');
  const list = document.createElement('div'); list.className = 'mobile-control-list';
  for (const [id, name, valueId, icon] of [
    ['modelControl', 'Model', 'modelLabel', '◉'],
    ['reasoningControl', 'Reasoning', 'reasoningLabel', '◌'],
    ['permissionControl', 'Permissions', 'permissionLabel', '◫'],
    ['usageControl', 'Usage', 'usageLabel', '▤']
  ]) {
    const original = document.getElementById(id);
    const button = document.createElement('button'); button.type = 'button';
    button.disabled = original.disabled;
    const symbol = document.createElement('span'); symbol.setAttribute('aria-hidden', 'true'); symbol.textContent = icon;
    const copy = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = name;
    const value = document.createElement('small'); value.textContent = document.getElementById(valueId).textContent;
    const arrow = document.createElement('b'); arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '›';
    copy.append(title, value); button.append(symbol, copy, arrow);
    button.addEventListener('click', () => { closeControlPopover(); original.click(); });
    list.append(button);
  }
  popover.append(list);
}

async function openPicker(configId, title, eyebrow, anchor) {
  if (state.openControl === anchor.id) return closeControlPopover();
  if (!state.currentId) {
    if (!state.currentProjectPath) return showToast("Select a project before changing chat settings.");
    const sessionId = await startNewChat(state.currentProjectPath, { focus: false });
    if (!sessionId) return;
  }
  if (!config(configId) && state.configReady) {
    const sessionId = state.currentId;
    await state.configReady;
    if (state.currentId !== sessionId) return;
  }
  const option = config(configId);
  if (!option) return showToast('This setting is not available for the current task.');
  const popover = showControlPopover(anchor, title, eyebrow);
  const isModelPicker = configId === 'model';
  const pickerSessionId = state.currentId;
  if (option.description) {
    const hint = document.createElement('p'); hint.className = 'popover-hint'; hint.textContent = option.description; popover.append(hint);
  }
  if (isModelPicker) {
    const hint = document.createElement('p'); hint.className = 'popover-hint';
    hint.textContent = 'Tap ☆ beside a model to pin it at the top. Recommended models are listed next, without stars.';
    hint.classList.add('favorite-hint');
    popover.append(hint);
  }
  const search = (option.options || []).length > 8 ? document.createElement('input') : null;
  if (search) {
    search.className = 'popover-search'; search.type = 'search';
    search.placeholder = `Search ${title.toLowerCase()}…`; search.setAttribute('aria-label', search.placeholder);
    search.autocomplete = 'off'; popover.append(search);
  }
  const list = document.createElement('div'); list.className = 'popover-options'; list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', title); popover.append(list);
  const draw = () => {
    const current = config(configId) || option;
    const choices = current.options || [];
    const query = search?.value.trim().toLowerCase() || '';
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    const filtered = choices.filter((item) => `${item.name || item.label || ''} ${item.value || item.id || ''} ${item.description || ''}`.toLowerCase().includes(query)).slice(0, 100);
    if (!filtered.length) {
      const empty = document.createElement('p'); empty.className = 'popover-empty'; empty.textContent = 'No matching options'; list.append(empty); return;
    }
    for (const choice of filtered) {
      const value = choice.value ?? choice.id;
      const selected = value === current.currentValue;
      const favorite = Boolean(choice.favorite || /^★\s+/.test(choice.name || ''));
      const displayName = (choice.name || choice.label || value).replace(/^★\s+/, '');
      // The row is a container so the select control and the favorite star are
      // separate real buttons; nested interactive elements inside a single
      // button are ignored by several mobile browsers.
      const row = document.createElement('div'); row.className = 'picker-row';
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(selected));
      const button = document.createElement('button'); button.type = 'button';
      button.className = `picker-option${selected ? ' current' : ''}`;
      const copy = document.createElement('span');
      const name = document.createElement('strong'); name.textContent = displayName;
      const details = document.createElement('small'); details.textContent = choice.description || value;
      copy.append(name, details); button.append(copy);
      if (selected) { const check = document.createElement('i'); check.textContent = '✓'; button.append(check); }
      button.addEventListener('click', () => updateConfig(option.id, value));
      row.append(button);
      if (isModelPicker) {
        const star = document.createElement('button'); star.type = 'button';
        star.className = `favorite-star${favorite ? ' active' : ''}`;
        // The star is a distinct tap target, not part of the model selection.
        // Keep its sizing in CSS: CSP forbids inline styles in the console.
        const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        glyph.setAttribute('viewBox', '0 0 24 24'); glyph.setAttribute('width', '20'); glyph.setAttribute('height', '20');
        glyph.setAttribute('aria-hidden', 'true');
        const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        shape.setAttribute('d', 'M12 3.2l2.8 5.85 6.4.8-4.7 4.5 1.2 6.4L12 17.65 6.3 20.75l1.2-6.4-4.7-4.5 6.4-.8z');
        shape.setAttribute('fill', favorite ? 'currentColor' : 'none');
        shape.setAttribute('stroke', 'currentColor');
        shape.setAttribute('stroke-width', '1.7');
        shape.setAttribute('stroke-linejoin', 'round');
        glyph.append(shape); star.append(glyph);
        star.title = favorite ? 'Remove from favorites' : 'Add to favorites';
        star.setAttribute('aria-label', `${favorite ? 'Remove' : 'Add'} ${displayName} ${favorite ? 'from' : 'to'} favorites`);
        star.setAttribute('aria-pressed', String(favorite));
        star.addEventListener('click', () => {
          star.disabled = true;
          void toggleModelFavorite(value, pickerSessionId, () => {
            if (state.currentId === pickerSessionId && !popover.hidden && state.openControl === anchor.id) draw();
          }).finally(() => { star.disabled = false; });
        });
        row.append(star);
      }
      list.append(row);
    }
    list.scrollTop = scrollTop;
  };
  search?.addEventListener('input', () => { list.scrollTop = 0; draw(); });
  draw();
  if (isModelPicker && state.currentProvider === 'openai-codex') {
    // Render cached options immediately, then discover additions without
    // changing the selected model or closing the picker.
    void requestJson(`/api/sessions/${pickerSessionId}/config`, {
      method: 'POST', body: JSON.stringify({ configId: 'refresh_models', value: 'auto' })
    }).then((result) => {
      if (state.currentId !== pickerSessionId) return;
      if (result.configOptions) state.configOptions = applyModelFavorites(result.configOptions, state.modelFavorites);
      applyConfigLabels();
      if (!popover.hidden && state.openControl === anchor.id) draw();
    }).catch(() => { /* Keep the usable cached picker if discovery fails. */ });
  }
  if (search) requestAnimationFrame(() => search.focus());
}

function openUsagePopover(anchor) {
  const popover = showControlPopover(anchor, 'Conversation usage', 'USAGE');
  const usage = state.usage;
  const provider = state.currentProvider;
  const quota = state.subscriptionUsage[provider];
  const baseline = state.subscriptionBaseline?.provider === provider ? state.subscriptionBaseline : null;
  const shortIncrease = subscriptionIncrease(baseline?.short, quota?.short);
  const longIncrease = subscriptionIncrease(baseline?.long, quota?.long);
  const subscribed = provider === 'claude-code' || provider === 'openai-codex';
  const model = config('model')?.currentValue || state.sessions.find((item) => item.sessionId === state.currentId)?.currentModel;
  const subagents = state.subagentUsage;
  // The thread's API equivalent prices only its own model; subagents are listed separately.
  const own = subagents ? Object.fromEntries(['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens']
    .map((key) => [key, Math.max(0, (usage[key] || 0) - (subagents[key] || 0))])) : usage;
  const equivalent = subscribed ? apiEquivalent(own, provider, model, state.usageReference) : null;
  const cacheReadHeuristic = assumesCacheReadRate(own, provider, model, state.usageReference);
  const subagentCharge = subagents?.apiResponses ? `${formatCost(subagents.apiCost)}${subagents.unpricedApiResponses ? ' (partial)' : ''}` : null;
  const contextPercent = threadContextPercent(usage);
  const trackingLabel = baseline?.origin === "first-observed" ? "Since first viewed" : "Since thread started";
  const cachedPercent = usage.inputTokens > 0 ? `${Math.round(100 * usage.cachedReadTokens / usage.inputTokens)}%` : '0%';
  const rows = [
    ['Actual charge', subscribed ? (subagentCharge ? `Plan + ${subagentCharge} API` : 'Included with plan')
      : usage.costKnown ? formatCost(usage.costAmount) : usage.hasUsage ? 'Unavailable' : '$0.00'],
    ...(subagents ? [['Subagents · API charges', subagentCharge || '$0.00'], ['Subagents · tokens', compactCount(subagents.tokens)]] : []),
    ...(subscribed ? [[`API equivalent · thread${cacheReadHeuristic ? ' · 10% assumed cache rate' : ''}`, equivalent === null ? 'Unavailable' : formatEstimatedCost(equivalent)],
      ['Thread context used', contextPercent === null ? 'Unavailable' : `${contextPercent}%`]] : []),
    ['Input tokens', compactCount(usage.inputTokens)],
    ['Output tokens', compactCount(usage.outputTokens)],
    ['Total tokens', compactCount(usage.inputTokens + usage.outputTokens)],
    ['Cached input', `${compactCount(usage.cachedReadTokens)} · ${cachedPercent} of input`],
    ['Cache written', compactCount(usage.cachedWriteTokens)],
    ['Reasoning tokens', compactCount(usage.thoughtTokens)]
  ];
  if (subscribed) {
    rows.unshift(
      ["Subscription · 5 hours", formatQuota(quota?.short)],
      [`${trackingLabel} · 5h`, formatSubscriptionIncrease(shortIncrease)],
      ["Subscription · 7 days", formatQuota(quota?.long)],
      [`${trackingLabel} · 7d`, formatSubscriptionIncrease(longIncrease)]
    );
  }
  const details = document.createElement('div'); details.className = 'usage-details';
  const grid = document.createElement('div'); grid.className = 'usage-stats';
  for (const [label, value] of rows) {
    const cell = document.createElement('div'); cell.className = 'usage-stat';
    const name = document.createElement('span'); name.textContent = label;
    const amount = document.createElement('strong'); amount.textContent = value;
    cell.append(name, amount); grid.append(cell);
  }
  details.append(grid);
  const context = document.createElement('p'); context.className = 'usage-context';
  context.textContent = contextPercent !== null
    ? `Latest context: ${compactCount(usage.used)} / ${compactCount(usage.size)} tokens (${contextPercent}%).`
    : 'Context window details are not reported for this model.';
  details.append(context);
  const note = document.createElement('p'); note.className = 'popover-hint usage-note';
  note.textContent = subscribed
    ? `The percentage-point change is account-wide, not a measured per-thread share. New threads are snapshotted at creation; older threads start tracking on first view. Other chats/devices can affect it; delayed reports or a window reset cannot be reconstructed. Thread context % uses the latest request and a catalog reference window when available. API equivalent assumes ${model || 'the selected model'} throughout, text rates and 5-minute cache writes. For Codex models without bundled API rates, catalog input/output rates are used with an assumed cache-read rate of 10% of ordinary input. This is a heuristic, not a verified rate; other models can differ. Cache writes with unknown prices remain Unavailable. This is not a charge and may differ from direct API pricing. Unknown rates or context windows show Unavailable.`
    : 'Cached reads are included in input. Cost is shown only when the provider reports an actual charge.';
  details.append(note);
  popover.append(details);
}

async function toggleModelFavorite(modelId, sessionId, redraw) {
  try {
    const result = await requestJson(`/api/sessions/${sessionId}/favorite-model`, { method: 'POST', body: JSON.stringify({ modelId }) });
    if (state.currentId !== sessionId) return;
    state.modelFavorites = result.favorites || [];
    state.configOptions = applyModelFavorites(state.configOptions, state.modelFavorites);
    applyConfigLabels();
    redraw?.();
    showToast(result.added ? 'Added to favorites' : 'Removed from favorites');
  } catch (error) { showToast(error.message); }
}

async function updateConfig(configId, value) {
  const sessionId = state.currentId;
  try {
    const result = await requestJson(`/api/sessions/${sessionId}/config`, { method: 'POST', body: JSON.stringify({ configId, value }) });
    if (state.currentId !== sessionId) return;
    state.configOptions = result.configOptions || state.configOptions;
    const option = state.configOptions.find((item) => item.id === configId); if (option) option.currentValue = value;
    applyConfigLabels(); renderUsageLabel(); closeControlPopover(); showToast('Task setting updated');
  } catch (error) { showToast(error.message); }
}

async function refresh() {
  try {
    const projectData = await requestJson("/api/projects");
    state.projects = projectData.projects || [];
    state.removedProjectPaths = projectData.removedProjectPaths || [];
    state.oneOffWorkspacePath = projectData.oneOffWorkspacePath || null;
  }
  catch (error) { showToast(error.message); }
  let availableProjects = projectViews();
  if (state.currentProjectPath && !availableProjects.some((item) => item.path === state.currentProjectPath)) state.currentProjectPath = null;
  if (!state.currentProjectPath && !state.currentId && availableProjects.length) {
    let remembered = null;
    try { remembered = localStorage.getItem("unreal-console-project"); } catch {}
    selectProject(availableProjects.find((item) => item.path === remembered)?.path || availableProjects[0].path);
  }
  renderSessions();

  const [statusResult, sessionsResult] = await Promise.allSettled([requestJson("/api/status"), requestJson("/api/sessions")]);
  if (sessionsResult.status === "fulfilled") {
    const serverSessions = (sessionsResult.value.sessions || []).filter((item) => item.agentId === "unreal");
    const serverIds = new Set(serverSessions.map((item) => item.sessionId));
    const pendingChats = state.sessions.filter((item) => (item.pendingRemote || item.draft) && !serverIds.has(item.sessionId))
      .map((item) => ({ ...item, pendingRemote: true }));
    state.sessions = [...serverSessions, ...pendingChats]
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    savePendingDrafts();
  }
  availableProjects = projectViews();
  if (state.currentProjectPath && !availableProjects.some((item) => item.path === state.currentProjectPath)) state.currentProjectPath = null;
  if (!state.currentProjectPath && !state.currentId && availableProjects.length) {
    let remembered = null;
    try { remembered = localStorage.getItem("unreal-console-project"); } catch {}
    selectProject(availableProjects.find((item) => item.path === remembered)?.path || availableProjects[0].path);
  }
  renderSessions();
  if (statusResult.status === "fulfilled") {
    if (!state.currentId) setConnection(Boolean(statusResult.value.ready), "Hydra connected");
  } else {
    setConnection(false, "Hydra unavailable");
    if (!state.sessions.length) showToast(sessionsResult.status === "rejected" ? sessionsResult.reason.message : statusResult.reason.message);
  }
}
function loadPrefs() {
  try { state.prefs = { ...state.prefs, ...JSON.parse(localStorage.getItem("unreal-console-prefs") || "{}") }; } catch {}
  if (!["system", "light", "dark", "warm"].includes(state.prefs.theme)) state.prefs.theme = "system";
  if (!["auto", "cost", "subscription"].includes(state.prefs.usageMetric)) state.prefs.usageMetric = "auto";
  renderUsageLabel();
  state.prefs.jambalayaMode = state.prefs.jambalayaMode === true;
  document.body.dataset.theme = state.prefs.theme; document.body.dataset.accent = state.prefs.accent;
  applyBranding();
}
const systemAppearance = window.matchMedia("(prefers-color-scheme: light)");
function updateThemeColor() {
  const isLight = state.prefs.theme === "light" || (state.prefs.theme === "system" && systemAppearance.matches);
  if (state.prefs.jambalayaMode) {
    document.querySelector('meta[name="theme-color"]').content = isLight ? "#fff3e0" : "#21120c";
    return;
  }
  document.querySelector('meta[name="theme-color"]').content = isLight ? "#f4f5f2" : "#0f100e";
}
const handleSystemAppearanceChange = () => {
  if (state.prefs.theme === "system") updateThemeColor();
};
if (systemAppearance.addEventListener) systemAppearance.addEventListener("change", handleSystemAppearanceChange);
else systemAppearance.addListener(handleSystemAppearanceChange);
function selectedCatalogProvider() {
  return state.modelProviders.find((provider) => provider.id === state.catalogProvider);
}

function renderDefaultModel(form, saved = "") {
  const provider = state.modelProviders.find((item) => item.id === form.elements.defaultProvider.value);
  const choices = [...(provider?.models || [])];
  const missing = saved && !choices.some((model) => model.value === saved);
  if (missing) choices.unshift({ value: saved, name: `${saved} (unavailable)` });
  form.elements.defaultModel.replaceChildren(...[{ value: "", name: provider?.local ? "First available local model" : "Provider default" }, ...choices].map((model) => {
    const option = document.createElement("option"); option.value = model.value; option.textContent = model.name; return option;
  }));
  form.elements.defaultModel.value = saved;
  form.elements.defaultProvider.disabled = !state.modelSettingsReady;
  form.elements.defaultModel.disabled = !state.modelSettingsReady;
  form.elements.defaultThoughtLevel.disabled = !state.modelSettingsReady;
  $("#defaultModelHint").textContent = missing
    ? "Your saved model is no longer listed. Choose another model, or new chats will use the provider default."
    : provider?.local && !choices.length ? "Start the local server or add a model ID before starting a new chat." : "Existing chats keep their provider and model.";
}

let dashboardRequest = 0;
function dashboardStat(label, value, exactTokens = null) {
  const cell = document.createElement('div'); cell.className = 'usage-stat';
  const caption = document.createElement('span'); caption.textContent = label;
  const number = document.createElement('strong'); number.textContent = value;
  if (exactTokens !== null) {
    number.title = `${exactTokens.toLocaleString()} tokens`;
    number.setAttribute('aria-label', number.title);
  }
  cell.append(caption, number); return cell;
}
function dashboardUsageTable(label, rows, subscribed) {
  const wrapper = document.createElement('div'); wrapper.className = 'dashboard-table-wrap';
  const table = document.createElement('table'); table.className = 'dashboard-table';
  const caption = document.createElement('caption'); caption.className = 'sr-only'; caption.textContent = label;
  const head = document.createElement('thead'), header = document.createElement('tr');
  for (const column of [label, 'Total', 'Input', 'Output', 'Cached input', subscribed ? 'API equivalent' : 'API charge']) {
    const th = document.createElement('th'); th.scope = 'col'; th.textContent = column; header.append(th);
  }
  head.append(header);
  const body = document.createElement('tbody');
  for (const [name, data] of rows) {
    const row = document.createElement('tr');
    const title = document.createElement('th'); title.scope = 'row'; title.textContent = name; row.append(title);
    for (const field of ['tokens', 'inputTokens', 'outputTokens', 'cachedReadTokens']) {
      const td = document.createElement('td');
      const count = data[field] ?? 0;
      td.textContent = formatDashboardTokens(count);
      td.title = `${count.toLocaleString()} tokens`;
      td.setAttribute('aria-label', td.title);
      row.append(td);
    }
    const dollars = document.createElement('td');
    dollars.textContent = formatEstimatedCost(data.dollars) + (data.unpricedTokens ? ' + unpriced' : '');
    row.append(dollars); body.append(row);
  }
  table.append(caption, head, body); wrapper.append(table);
  return wrapper;
}
function dashboardSection(title, data, subscribed) {
  const card = document.createElement('article'); card.className = 'dashboard-card';
  const heading = document.createElement('h4'); heading.textContent = title; card.append(heading);
  const summary = document.createElement('div'); summary.className = 'usage-stats';
  const tokenStat = (label, count) => dashboardStat(label, formatDashboardTokens(count), count);
  summary.append(tokenStat('Recorded tokens · all time', data.allTime.tokens + data.earlierTokens),
    tokenStat('Input tokens · all time', data.allTime.inputTokens + (data.earlierInputTokens ?? 0)),
    tokenStat('Output tokens · all time', data.allTime.outputTokens + (data.earlierOutputTokens ?? 0)),
    tokenStat('Cached input · all time', (data.allTime.cachedReadTokens ?? 0) + (data.earlierCachedReadTokens ?? 0)),
    dashboardStat(subscribed ? 'API equivalent · priced usage' : 'Actual API charges · reported', formatEstimatedCost(data.allTime.dollars)));
  card.append(summary);
  const cacheNote = document.createElement('p'); cacheNote.className = 'theme-hint';
  cacheNote.textContent = 'Totals include chat responses, subagents, generated titles and project memories. Each response counts under the provider that served it, so a Codex chat\'s OpenRouter subagents appear under API use. Cached input is included in input and total tokens, not added again.';
  card.append(cacheNote);
  if (data.earlierTokens) {
    const note = document.createElement('p'); note.className = 'theme-hint';
    note.textContent = `${formatDashboardTokens(data.earlierTokens)} earlier tokens have no response dates or reliable model/rate; excluded from periods and dollar totals.`;
    card.append(note);
  }
  if (data.allTime.unpricedTokens) {
    const note = document.createElement('p'); note.className = 'theme-hint';
    note.textContent = `${formatDashboardTokens(data.allTime.unpricedTokens)} recorded tokens have no ${subscribed ? 'known model rate' : 'reported charge'}; dollar totals are partial.`;
    card.append(note);
  }
  if (Object.keys(data.purposes || {}).length) {
    const header = document.createElement('h5'); header.textContent = 'Inference purpose · all time'; card.append(header);
    const labels = { main: 'Chat responses', title: 'Generated titles', memory: 'Project memory', synopsis: 'Session synopsis', subagent: 'Subagents' };
    card.append(dashboardUsageTable('Purpose', Object.entries(data.purposes).map(([purpose, bucket]) =>
      [labels[purpose] || purpose, bucket]), subscribed));
  }
  if (Object.keys(data.agents || {}).length) {
    const header = document.createElement('h5'); header.textContent = 'Subagents · all time'; card.append(header);
    card.append(dashboardUsageTable('Subagent', Object.entries(data.agents).sort(([, a], [, b]) => b.dollars - a.dollars || b.tokens - a.tokens)
      .map(([agent, bucket]) => [agent.charAt(0).toUpperCase() + agent.slice(1), bucket]), subscribed));
  }
  for (const [label, column, periods] of [['Weekly', 'Week (UTC)', data.weeks], ['Monthly', 'Month (UTC)', data.months]]) {
    const header = document.createElement('h5'); header.textContent = label; card.append(header);
    card.append(dashboardUsageTable(column, periods.map((period) => [period.start, period]), subscribed));
  }
  const header = document.createElement('h5'); header.textContent = 'Models used · all time'; card.append(header);
  if (!data.allTime.models.length) {
    const empty = document.createElement('p'); empty.className = 'theme-hint'; empty.textContent = 'No dated responses yet.'; card.append(empty);
  } else {
    card.append(dashboardUsageTable('Model', data.allTime.models.map((model) =>
      [`${model.provider} · ${model.model}`, model]), subscribed));
  }
  return card;
}
async function refreshDashboard() {
  const request = ++dashboardRequest;
  $('#dashboardStatus').textContent = 'Loading usage…';
  try {
    const data = await requestJson('/api/usage-dashboard');
    if (request !== dashboardRequest || !ui.preferencesDialog.open) return;
    $('#dashboardCards').replaceChildren(dashboardSection('Subscriptions · Claude & Codex', data.subscriptions, true),
      dashboardSection('API use', data.api, false));
    $('#dashboardStatus').textContent = 'Subscription dollars are indicative API equivalents, not charges. API dollars are provider-reported charges only. Local models are excluded. Only responses recorded after tracking began appear in weekly and monthly breakdowns.';
  } catch {
    if (request === dashboardRequest) $('#dashboardStatus').textContent = 'Usage could not be loaded. Reopen this tab to retry.';
  }
}
function selectSettingsTab(name) {
  if (name === 'dashboard') void refreshDashboard();
  document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
    const selected = tab.dataset.settingsTab === name;
    tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
  });
}

function renderProviderTabs() {
  const defaultProvider = $("#preferencesForm").elements.defaultProvider.value;
  $("#providerTabs").replaceChildren(...state.modelProviders.map((provider) => {
    const tab = document.createElement("button"); tab.type = "button"; tab.className = "provider-tab";
    tab.id = `provider-${provider.id}`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", "providerCatalog");
    tab.setAttribute("aria-selected", String(provider.id === state.catalogProvider)); tab.tabIndex = provider.id === state.catalogProvider ? 0 : -1;
    const heading = document.createElement("span"); heading.className = "provider-tab-heading";
    const name = document.createElement("strong"); name.textContent = provider.name;
    heading.append(name);
    if (provider.id === defaultProvider) {
      const badge = document.createElement("span"); badge.className = "provider-default-badge"; badge.textContent = "Default"; heading.append(badge);
    }
    const detail = document.createElement("small"); detail.textContent = `${provider.models.length} models${provider.id === "claude-code" ? ` · ${provider.status === "connected" ? "Signed in" : "Sign in required"}` : provider.local ? provider.status === "offline" ? " · Offline" : " · Local" : ""}`;
    tab.append(heading, detail); tab.title = provider.description;
    tab.addEventListener("click", () => {
      state.catalogProvider = provider.id; state.catalogError = ""; $("#modelSearch").value = "";
      renderProviderTabs(); renderSettingsModels(); $("#settingsModelList").scrollTop = 0; document.getElementById(tab.id)?.focus();
    });
    return tab;
  }));
  const provider = selectedCatalogProvider();
  if (provider) $("#providerCatalog").setAttribute("aria-labelledby", `provider-${provider.id}`);
  document.getElementById(`provider-${state.catalogProvider}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderSettingsModels() {
  const form = $("#preferencesForm"), provider = selectedCatalogProvider();
  const search = $("#modelSearch").value.trim().toLowerCase();
  const models = (provider?.models || []).filter((model) => `${model.name} ${model.value} ${model.description || ""}`.toLowerCase().includes(search));
  const list = $("#settingsModelList");
  list.replaceChildren(...models.map((model) => {
    const row = document.createElement("div"); row.className = "settings-model-row";
    const copy = document.createElement("div"); copy.className = "settings-model-copy";
    const name = document.createElement("strong"); name.textContent = model.name.replace(/^★\s+/, "").split(" · ")[0];
    const id = document.createElement("span"); id.className = "settings-model-id"; id.textContent = model.value;
    copy.append(name, id);
    if (model.description) { const detail = document.createElement("small"); detail.textContent = model.description; copy.append(detail); }
    const isDefault = form.elements.defaultProvider.value === provider.id && form.elements.defaultModel.value === model.value;
    row.classList.toggle("is-default", isDefault);
    const button = document.createElement("button"); button.type = "button"; button.className = "model-set-default";
    button.textContent = isDefault ? "✓ Default" : "Use as default";
    button.disabled = !state.modelSettingsReady || isDefault;
    button.setAttribute("aria-label", isDefault ? `${name.textContent} is the default model` : `Use ${name.textContent} as the default model`);
    button.addEventListener("click", () => {
      form.elements.defaultProvider.value = provider.id;
      renderDefaultModel(form, model.value); renderProviderTabs(); renderSettingsModels();
    });
    row.append(copy, button); return row;
  }));
  if (!models.length) {
    const empty = document.createElement("p"); empty.className = "catalog-empty";
    empty.textContent = state.catalogLoading ? "Loading model catalog…" : provider?.local && !provider.models.length ? provider.error || "No models are listed. Edit this connection to add model IDs." : provider ? "No models match your search." : "The model catalog could not be loaded. Reopen settings to try again.";
    list.append(empty);
  }
  $("#localConnectionSummary").hidden = !provider?.local;
  $("#openrouterKeyPanel").hidden = provider?.id !== "openrouter";
  $("#localConnectionAddress").textContent = provider?.local ? provider.baseUrl : "";
  $("#addLocalProvider").disabled = !state.modelSettingsReady;
  $("#modelCatalogCount").textContent = provider ? search ? `${models.length} of ${provider.models.length} models` : `${provider.models.length} available models` : "";
  syncRefreshModels();
}

async function openPreferences() {
  if (ui.preferencesDialog.open) return;
  const loadId = ++state.preferencesLoadId, form = $("#preferencesForm");
  state.modelSettingsReady = false; state.catalogLoading = true; state.catalogError = "";
  form.elements.defaultProvider.disabled = true; form.elements.defaultModel.disabled = true; form.elements.defaultThoughtLevel.disabled = true;
  form.elements.theme.value = state.prefs.theme; form.elements.accent.value = state.prefs.accent;
  form.elements.jambalayaMode.checked = state.prefs.jambalayaMode;
  form.elements.showThoughts.checked = state.prefs.showThoughts;
  form.elements.usageMetric.value = state.prefs.usageMetric;
  void refreshSettingsSubscriptionUsage(); void refreshOpenRouterKey();
  $("#modelSearch").value = ""; $("#savePreferences").disabled = true;
  renderSettingsModels(); ui.preferencesDialog.showModal(); selectSettingsTab("dashboard");
  const results = await Promise.allSettled([
    requestJson("/api/capabilities"), requestJson("/api/generation-settings"),
    requestJson("/api/default-model"), requestJson("/api/models"), requestJson("/api/agents")
  ]);
  if (loadId !== state.preferencesLoadId) return;
  const [capabilities, generation, defaults, catalog, agents] = results;
  if (capabilities.status === "fulfilled") state.capabilities = capabilities.value.settings;
  if (generation.status === "fulfilled") {
    state.generation = generation.value.settings; state.generationModels = generation.value.models || [];
  }
  state.catalogLoading = false;
  state.modelSettingsReady = defaults.status === "fulfilled" && catalog.status === "fulfilled";
  if (catalog.status === "fulfilled") { state.modelProviders = catalog.value.providers; state.localPresets = catalog.value.localPresets || []; }
  else state.catalogError = catalog.reason.message;
  const preferred = defaults.status === "fulfilled" ? defaults.value.settings : {};
  // Older installations stored only a model; infer its provider from the catalog.
  const providerId = preferred.provider || state.modelProviders.find((provider) => provider.models.some((model) => model.value === preferred.model))?.id
    || (catalog.status === "fulfilled" ? catalog.value.defaultProvider : null) || state.modelProviders[0]?.id;
  form.elements.defaultProvider.replaceChildren(...state.modelProviders.map((provider) => {
    const option = document.createElement("option"); option.value = provider.id; option.textContent = provider.name; return option;
  }));
  form.elements.defaultProvider.value = providerId || "";
  state.catalogProvider = providerId;
  renderDefaultModel(form, preferred.model || ""); renderProviderTabs(); renderSettingsModels();
  form.elements.defaultThoughtLevel.value = preferred.thoughtLevel || "high";
  $("#settingsModelList").scrollTop = 0;
  const agentSettings = agents.status === "fulfilled" ? agents.value.settings : { enabled: false, maxConcurrent: 3, subagents: [] };
  form.elements.agentsEnabled.checked = agentSettings.enabled;
  form.elements.agentsMaxConcurrent.value = String(agentSettings.maxConcurrent);
  form.elements.agentsDelegation.value = String(agentSettings.delegation || 3);
  const swarm = agentSettings.swarm || {};
  form.elements.swarmEnabled.checked = swarm.enabled === true;
  form.elements.swarmUse.value = swarm.use || "asked";
  form.elements.swarmSize.value = String(swarm.size || 4);
  form.elements.swarmMessages.value = String(swarm.maxMessages || 60);
  renderDelegationLevel();
  renderSubagents($("#subagentList"), agentSettings.subagents, state.modelProviders, syncSubagentControls);
  form.elements.appleNotes.checked = state.capabilities.appleNotes;
  form.elements.appleCalendar.checked = state.capabilities.appleCalendar;
  for (const name of ["memoryModel", "titleModel"]) {
    form.elements[name].replaceChildren(...state.generationModels.map((model) => {
      const option = document.createElement("option");
      option.value = model.id; option.textContent = `${model.label} — ${model.description}`;
      return option;
    }));
  }
  form.elements.memoryEnabled.checked = state.generation.memoryEnabled;
  form.elements.memoryModel.value = state.generation.memoryModel;
  form.elements.titleEnabled.checked = state.generation.titleEnabled;
  form.elements.titleModel.value = state.generation.titleModel;
  syncGenerationControls(form);
  $("#savePreferences").disabled = results.some((result) => result.status === "rejected");
  const failed = results.find((result) => result.status === "rejected");
  if (failed) showToast(failed.reason.message);
}

function syncRefreshModels() {
  const button = $("#refreshModels"), status = $("#refreshModelsStatus"), provider = selectedCatalogProvider();
  button.disabled = !provider || state.catalogLoading || state.refreshingModels;
  button.hidden = provider?.source === "bundled" && !["claude-code", "openai-codex"].includes(provider?.id);
  button.lastChild.textContent = state.refreshingModels ? " Refreshing…" : " Refresh";
  $("#settingsModelList").setAttribute("aria-busy", String(state.catalogLoading || state.refreshingModels));
  status.textContent = state.catalogLoading ? "Loading providers…" : state.refreshingModels ? "Updating catalog…" : state.catalogError
    || provider?.error || (provider?.source === "local" ? "Local model server" : provider?.source === "bundled" ? (provider.status === "connected" ? (provider.id === "openai-codex" ? "Login file found" : "Signed in") : provider.status === "not-installed" ? "Install CLI to connect" : "Sign in required") : provider?.source === "fallback" ? "Built-in list · refresh to get the latest catalog" : provider?.updatedAt ? `Updated ${new Date(provider.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "");
}

async function refreshModelList() {
  const provider = selectedCatalogProvider(); if (!provider || state.refreshingModels) return;
  const loadId = state.preferencesLoadId;
  state.refreshingModels = true; state.catalogError = ""; syncRefreshModels();
  try {
    const result = await requestJson("/api/models/refresh", { method: "POST", body: JSON.stringify({ provider: provider.id }) });
    if (loadId !== state.preferencesLoadId) return;
    state.modelProviders = result.providers;
    const form = $("#preferencesForm"); renderDefaultModel(form, form.elements.defaultModel.value);
    renderProviderTabs(); renderSettingsModels();
    showToast(`${provider.name} model catalog refreshed`);
  } catch (error) {
    if (loadId === state.preferencesLoadId) { state.catalogError = error.message; showToast(error.message); }
  }
  finally { state.refreshingModels = false; syncRefreshModels(); }
}

function localConnectionInput() {
  const form = $("#localProviderForm"), input = {
    ...(state.editingLocalProvider ? { id: state.editingLocalProvider } : {}),
    type: form.elements.localType.value, name: form.elements.localName.value,
    baseUrl: form.elements.localBaseUrl.value,
    manualModels: form.elements.localModelIds.value.split("\n").map((value) => value.trim()).filter(Boolean)
  };
  if (form.elements.localClearKey.checked) input.apiKey = "";
  else if (form.elements.localApiKey.value || !state.editingLocalProvider) input.apiKey = form.elements.localApiKey.value;
  return input;
}

function openLocalProvider(connection = null) {
  const form = $("#localProviderForm"); form.reset(); state.editingLocalProvider = connection?.id || null;
  form.elements.localType.replaceChildren(...state.localPresets.map((preset) => {
    const option = document.createElement("option"); option.value = preset.id; option.textContent = preset.name; return option;
  }));
  const preset = state.localPresets.find((item) => item.id === connection?.type) || state.localPresets[0];
  if (!preset) return showToast("Load the model catalog before adding a connection.");
  form.elements.localType.value = preset.id;
  form.elements.localName.value = connection?.name || preset.name;
  form.elements.localBaseUrl.value = connection?.baseUrl || preset.baseUrl;
  form.elements.localModelIds.value = (connection?.manualModels || []).map((model) => model.value).join("\n");
  $("#localKeyHint").textContent = connection?.hasApiKey ? "A key is saved. Leave blank to keep it." : "Optional, if your local server requires one";
  $("#localClearKeyRow").hidden = !connection?.hasApiKey;
  $("#localProviderTitle").textContent = connection ? "Edit local connection" : "Add local models";
  $("#saveLocalProvider").textContent = connection ? "Save connection" : "Add connection";
  $("#localProviderStatus").textContent = ""; $("#localDiscoveredModels").hidden = true;
  $("#localProviderDialog").showModal();
}

function setLocalProviderBusy(busy) {
  state.localProviderBusy = busy;
  $("#saveLocalProvider").disabled = busy; $("#testLocalProvider").disabled = busy;
  $("#closeLocalProvider").disabled = busy; $("#cancelLocalProvider").disabled = busy;
  for (const element of $("#localProviderForm").elements) if (element.matches("input, select, textarea")) element.disabled = busy;
}

async function testLocalProvider() {
  const form = $("#localProviderForm"); if (!form.reportValidity() || state.localProviderBusy) return;
  const input = localConnectionInput(); setLocalProviderBusy(true);
  $("#localProviderStatus").textContent = "Finding models…"; $("#localDiscoveredModels").hidden = true;
  try {
    const result = await requestJson("/api/local-providers/test", { method: "POST", body: JSON.stringify(input) });
    $("#localProviderStatus").textContent = result.models.length ? `Connected · ${result.models.length} models found` : "Connected. No models were listed; add model IDs manually.";
    const preview = $("#localDiscoveredModels");
    preview.replaceChildren(...result.models.map((model) => { const name = document.createElement("span"); name.textContent = model.name; return name; }));
    preview.hidden = !result.models.length;
  } catch (error) { $("#localProviderStatus").textContent = error.message; }
  finally { setLocalProviderBusy(false); }
}

async function saveLocalConnection(event) {
  event.preventDefault(); if (state.localProviderBusy) return;
  const input = localConnectionInput(), form = $("#preferencesForm");
  const defaultProvider = form.elements.defaultProvider.value, defaultModel = form.elements.defaultModel.value;
  setLocalProviderBusy(true); $("#localProviderStatus").textContent = "Saving connection…";
  try {
    const result = await requestJson("/api/local-providers", { method: "POST", body: JSON.stringify(input) });
    state.modelProviders = result.providers; state.localPresets = result.localPresets;
    form.elements.defaultProvider.replaceChildren(...state.modelProviders.map((provider) => {
      const option = document.createElement("option"); option.value = provider.id; option.textContent = provider.name; return option;
    }));
    form.elements.defaultProvider.value = defaultProvider;
    state.catalogProvider = result.provider.id; state.catalogError = ""; $("#modelSearch").value = "";
    renderDefaultModel(form, defaultModel); renderProviderTabs(); renderSettingsModels(); $("#settingsModelList").scrollTop = 0;
    $("#localProviderDialog").close(); showToast(state.editingLocalProvider ? "Local connection saved" : "Local connection added. Choose a model to use it as your default.");
  } catch (error) { $("#localProviderStatus").textContent = error.message; }
  finally { setLocalProviderBusy(false); }
}

function syncSubagentControls() {
  const cards = $("#subagentList").querySelectorAll(".subagent-card").length;
  $("#addSubagentPresets").hidden = cards > 0;
  $("#sameModelForAll").hidden = cards < 2;
  $("#subagentList").dataset.empty = String(!cards);
  syncAddSubagentMenu();
  syncOpenRouterWarning();
}

// OpenRouter key: stored in the keychain by the server; the page only learns whether one exists.
function renderOpenRouterKey() {
  const configured = state.openRouterKey;
  $("#openrouterKeyStatus").textContent = configured === null ? "Checking…" : configured ? "Saved" : "Not set up";
  $("#removeOpenrouterKey").hidden = !configured;
  $("#openrouterKeyInput").placeholder = configured ? "Paste a new key to replace the saved one" : "Paste your key (sk-or-…)";
  syncOpenRouterWarning();
}

async function refreshOpenRouterKey() {
  try { state.openRouterKey = (await requestJson("/api/openrouter-key")).configured; }
  catch { state.openRouterKey = null; }
  renderOpenRouterKey();
}

async function saveOpenRouterKey(remove = false) {
  const input = $("#openrouterKeyInput");
  if (!remove && !input.value.trim()) { input.focus(); return; }
  $("#saveOpenrouterKey").disabled = $("#removeOpenrouterKey").disabled = true;
  $("#openrouterKeyStatus").textContent = remove ? "Removing…" : "Checking the key with OpenRouter…";
  try {
    const result = remove ? await requestJson("/api/openrouter-key", { method: "DELETE" })
      : await requestJson("/api/openrouter-key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: input.value.trim() }) });
    state.openRouterKey = result.configured; input.value = "";
    renderOpenRouterKey();
    showToast(remove ? "OpenRouter key removed" : result.verified ? "OpenRouter key saved and verified" : "OpenRouter key saved. It could not be checked right now.");
  } catch (error) {
    renderOpenRouterKey();
    $("#openrouterKeyStatus").textContent = error.message;
  } finally { $("#saveOpenrouterKey").disabled = $("#removeOpenrouterKey").disabled = false; }
}

function renderDelegationLevel() {
  const level = delegationChoices.find((item) => item.level === Number($("#preferencesForm").elements.agentsDelegation.value)) || delegationChoices[2];
  $("#delegationName").textContent = level.name;
  $("#delegationDescription").textContent = level.description;
}

function syncOpenRouterWarning() {
  const usesOpenRouter = $("#preferencesForm").elements.defaultProvider.value === "openrouter"
    || collectSubagents($("#subagentList")).some((agent) => agent.provider === "openrouter");
  $("#agentsOpenrouterWarning").hidden = !(usesOpenRouter && state.openRouterKey === false);
}

// One provider and model for every subagent, either for the cards already in the
// list or for the five built-in subagents being added together.
function openSubagentModelDialog(mode) {
  const form = $("#subagentModelForm");
  const primary = $("#preferencesForm").elements;
  const current = mode === "apply" ? collectSubagents($("#subagentList"))[0] : null;
  const provider = current?.provider || primary.defaultProvider.value;
  const model = current ? current.model : primary.defaultModel.value;
  form.dataset.mode = mode;
  form.elements.provider.replaceChildren(...state.modelProviders.map((item) => new Option(item.name, item.id)));
  form.elements.provider.value = provider;
  const fillModels = (selected = "") => {
    form.elements.model.replaceChildren(...modelChoices(state.modelProviders, form.elements.provider.value, selected).map((item) => new Option(item.name, item.value)));
    form.elements.model.value = selected;
  };
  fillModels(model);
  form.elements.provider.onchange = () => fillModels();
  $("#subagentModelTitle").textContent = mode === "add" ? "Add the five built-in subagents" : "Use one model for all subagents";
  $("#subagentModelNote").textContent = mode === "add"
    ? "Pick the model all five will use. You can still change any of them afterwards."
    : "Every subagent switches to this provider and model. Their reasoning and access stay as they are.";
  $("#applySubagentModel").textContent = mode === "add" ? "Add five subagents" : "Apply to all";
  $("#subagentModelDialog").showModal();
}

function syncAddSubagentMenu() {
  const menu = $("#addSubagent");
  const placeholder = new Option("＋ Add subagent", "", true, true);
  placeholder.disabled = true; placeholder.hidden = true;
  menu.replaceChildren(placeholder, ...addChoices(collectSubagents($("#subagentList"))).map((choice) => {
    const item = new Option(choice.disabled ? `${choice.name} (added)` : choice.name, choice.value); item.disabled = Boolean(choice.disabled); return item;
  }));
}

// New subagents start on the last subagent's provider and model, or the primary agent's.
function addSubagentCards(agents, { keepModel = false } = {}) {
  const form = $("#preferencesForm").elements;
  const primary = { provider: form.defaultProvider.value, model: form.defaultModel.value };
  let first;
  for (const agent of agents) {
    const ready = keepModel ? agent : inheritModel(agent, collectSubagents($("#subagentList")), primary);
    const card = appendSubagent($("#subagentList"), ready, state.modelProviders, syncSubagentControls);
    first ||= card;
  }
  first?.querySelector('[data-agent-field="name"]')?.focus();
}

function syncGenerationControls(form = $("#preferencesForm")) {
  form.elements.memoryModel.disabled = !form.elements.memoryEnabled.checked;
  form.elements.titleModel.disabled = !form.elements.titleEnabled.checked;
}

const sidebarResize = $("#sidebarResize");
const sidebarWidthKey = "unreal-console-sidebar-width";
let sidebarDrag = null;
let preferredSidebarWidth = DEFAULT_SIDEBAR_WIDTH;
try {
  const saved = localStorage.getItem(sidebarWidthKey);
  if (saved !== null && Number.isFinite(Number(saved))) {
    preferredSidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Number(saved)));
    ui.sidebar.style.setProperty("--sidebar-width", `${preferredSidebarWidth}px`);
  }
} catch { /* Private browsing may disallow storage. */ }
function updateSidebarResizeValue() {
  sidebarResize.setAttribute("aria-valuemax", String(sidebarWidthLimit(window.innerWidth)));
  sidebarResize.setAttribute("aria-valuenow", String(clampSidebarWidth(preferredSidebarWidth, window.innerWidth)));
}
function setSidebarWidth(width, save = false) {
  preferredSidebarWidth = clampSidebarWidth(width, window.innerWidth);
  ui.sidebar.style.setProperty("--sidebar-width", `${preferredSidebarWidth}px`);
  sidebarResize.setAttribute("aria-valuemax", String(sidebarWidthLimit(window.innerWidth)));
  sidebarResize.setAttribute("aria-valuenow", String(preferredSidebarWidth));
  if (save) {
    try { localStorage.setItem(sidebarWidthKey, String(preferredSidebarWidth)); } catch {}
  }
}
updateSidebarResizeValue();
window.addEventListener("resize", updateSidebarResizeValue);
sidebarResize.addEventListener("pointerdown", (event) => {
  if (sidebarDrag || event.button !== 0 || window.innerWidth <= 760 || document.body.classList.contains("sidebar-collapsed")) return;
  event.preventDefault();
  sidebarDrag = { id: event.pointerId, x: event.clientX, width: ui.sidebar.getBoundingClientRect().width, previous: preferredSidebarWidth };
  sidebarResize.setPointerCapture(event.pointerId);
  document.body.classList.add("sidebar-resizing");
});
sidebarResize.addEventListener("pointermove", (event) => {
  if (sidebarDrag?.id !== event.pointerId) return;
  setSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
});
function endSidebarDrag(event, cancel = false) {
  if (sidebarDrag?.id !== event.pointerId) return;
  const previous = sidebarDrag.previous;
  sidebarDrag = null;
  document.body.classList.remove("sidebar-resizing");
  if (cancel) setSidebarWidth(previous);
  else setSidebarWidth(ui.sidebar.getBoundingClientRect().width, true);
  if (sidebarResize.hasPointerCapture(event.pointerId)) sidebarResize.releasePointerCapture(event.pointerId);
}
sidebarResize.addEventListener("pointerup", (event) => endSidebarDrag(event));
sidebarResize.addEventListener("pointercancel", (event) => endSidebarDrag(event, true));
sidebarResize.addEventListener("lostpointercapture", (event) => endSidebarDrag(event, true));
sidebarResize.addEventListener("keydown", (event) => {
  if (document.body.classList.contains("sidebar-collapsed")) return;
  const width = clampSidebarWidth(preferredSidebarWidth, window.innerWidth);
  const step = event.shiftKey ? 30 : 10;
  const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: MIN_SIDEBAR_WIDTH, End: sidebarWidthLimit(window.innerWidth) }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  setSidebarWidth(next, true);
});

$("#mobileMenu").addEventListener("click", () => ui.sidebar.classList.toggle("open"));
$("#collapseSidebar").addEventListener("click", (event) => {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  const button = event.currentTarget;
  button.textContent = collapsed ? "›" : "‹";
  button.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  button.setAttribute("title", collapsed ? "Expand sidebar" : "Collapse sidebar");
  button.setAttribute("aria-expanded", String(!collapsed));
});
$("#closeDeleteChatDialog").addEventListener("click", () => ui.deleteChatDialog.close());
$("#cancelDeleteChat").addEventListener("click", () => ui.deleteChatDialog.close());
ui.confirmDeleteChat.addEventListener("click", () => { void deleteSelectedChat(); });
ui.deleteChatDialog.addEventListener("close", () => {
  if (!state.deletingChat) state.pendingDeleteId = null;
});
ui.deleteChatDialog.addEventListener("cancel", (event) => {
  if (state.deletingChat) event.preventDefault();
});
async function startNewChat(folderPath = state.currentProjectPath, { focus = true, oneOff = false } = {}) {
  const project = oneOff ? null : projectViews().find((item) => item.path === folderPath);
  if (!oneOff && !project) { showToast("Add or select a project before starting a chat."); return; }
  if (state.creatingChat) return null;
  state.creatingChat = true;
  const newChatButton = $("#newThread"); newChatButton.disabled = true; newChatButton.setAttribute("aria-busy", "true");
  try {
    const result = await requestJson("/api/sessions", { method: "POST", body: JSON.stringify(oneOff ? { oneOff: true } : { cwd: project.path }) });
    const sessionId = result.sessionId;
    if (!sessionId) throw new Error("The new chat was created without a session ID.");
    if (!state.sessions.some((item) => item.sessionId === sessionId)) {
      const cwd = oneOff ? state.oneOffWorkspacePath : project.path;
      state.sessions.unshift({ sessionId, cwd, title: "New chat", agentId: "unreal", updatedAt: new Date().toISOString(), busy: false, status: "cold", draft: true, pendingRemote: true });
      savePendingDrafts();
    }
    state.currentProjectPath = project?.path || null;
    selectSession(sessionId, result.configOptions || []);
    if (focus) requestAnimationFrame(() => ui.prompt.focus());
    void refresh();
    return sessionId;
  } catch (error) { showToast(error.message); return null; }
  finally {
    state.creatingChat = false; newChatButton.disabled = false; newChatButton.removeAttribute("aria-busy");
    updateSendAvailability();
  }
}
$("#newThread").addEventListener("click", () => { void startNewChat(null, { oneOff: true }); });
$("#addProject").addEventListener("click", () => openProjectDialog());
$("#starterNewChat").addEventListener("click", () => { void startNewChat(state.currentProjectPath, { oneOff: !state.currentProjectPath }); });
$("#starterAddProject").addEventListener("click", () => $("#addProject").click());
$("#browseFolder").addEventListener("click", async () => {
  const button = $("#browseFolder"); button.disabled = true; button.textContent = "Choose a folder…";
  try { const result = await requestJson("/api/choose-folder", { method: "POST", body: "{}" }); $("#projectPath").value = result.path; }
  catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = "Browse folders…"; }
});
$("#closeProjectDialog").addEventListener("click", () => $("#projectDialog").close());
$("#cancelProject").addEventListener("click", () => $("#projectDialog").close());
$("#projectForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = $("#saveProject");
  const editing = Boolean(state.editingProjectPath);
  button.disabled = true; button.textContent = editing ? "Saving…" : "Adding…";
  try {
    if (state.editingProjectId) {
      const previousPath = state.editingProjectPath;
      const result = await requestJson(`/api/projects/${encodeURIComponent(state.editingProjectId)}`, {
        method: "PATCH", body: JSON.stringify({ name: $("#projectName").value.trim(), path: $("#projectPath").value.trim() })
      });
      state.projects = state.projects.map((item) => item.id === result.project.id ? result.project : item);
      if (state.expandedProjectPaths.has(previousPath)) setProjectExpanded(result.project.path, true);
      if (state.currentProjectPath === previousPath) {
        if (state.currentId) {
          const active = state.sessions.find((item) => item.sessionId === state.currentId);
          state.currentProjectPath = active ? projectForSession(active)?.path || null : result.project.path;
        } else {
          state.currentProjectPath = result.project.path;
          try { localStorage.setItem("unreal-console-project", result.project.path); } catch {}
          $("#taskTitle").textContent = result.project.name;
          $("#taskPath").textContent = result.project.path;
          $("#welcomeTitle").textContent = result.project.name;
          $("#welcomeCopy").hidden = true;
        }
      }
      ui.projectDialog.close(); renderSessions(); showToast("Project updated");
    } else {
      const result = await requestJson("/api/projects", { method: "POST", body: JSON.stringify({
        path: $("#projectPath").value.trim(),
        ...(state.editingLegacyProject ? { name: $("#projectName").value.trim() } : {})
      }) });
      ui.projectDialog.close(); await refresh(); selectProject(result.project.path);
    }
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = editing ? "Save changes" : "Add project"; }
});
$("#deleteProject").addEventListener("click", () => {
  const project = state.projects.find((item) => item.id === state.editingProjectId);
  if (project) openDeleteProject(project);
});
$("#confirmDeleteProject").addEventListener("click", () => { void deleteSelectedProject(); });
$("#closeDeleteProject").addEventListener("click", () => ui.deleteProjectDialog.close());
$("#cancelDeleteProject").addEventListener("click", () => ui.deleteProjectDialog.close());
ui.deleteProjectDialog.addEventListener("close", () => { if (!state.deletingProject) state.pendingProjectId = null; });
ui.deleteProjectDialog.addEventListener("cancel", (event) => { if (state.deletingProject) event.preventDefault(); });
$("#openPreferences").addEventListener("click", () => { void openPreferences(); });
$("#refreshModels").addEventListener("click", () => { void refreshModelList(); });
$("#addLocalProvider").addEventListener("click", () => openLocalProvider());
$("#editLocalProvider").addEventListener("click", () => openLocalProvider(selectedCatalogProvider()));
$("#closeLocalProvider").addEventListener("click", () => $("#localProviderDialog").close());
$("#cancelLocalProvider").addEventListener("click", () => $("#localProviderDialog").close());
$("#localProviderDialog").addEventListener("close", () => {
  $("#localProviderForm").elements.localApiKey.value = "";
});
$("#localProviderDialog").addEventListener("cancel", (event) => { if (state.localProviderBusy) event.preventDefault(); });
$("#localProviderForm").elements.localType.addEventListener("change", (event) => {
  const preset = state.localPresets.find((item) => item.id === event.target.value);
  if (!preset) return;
  const form = $("#localProviderForm"); form.elements.localName.value = preset.name; form.elements.localBaseUrl.value = preset.baseUrl;
  $("#localProviderStatus").textContent = ""; $("#localDiscoveredModels").hidden = true;
});
$("#testLocalProvider").addEventListener("click", () => { void testLocalProvider(); });
$("#localProviderForm").addEventListener("submit", saveLocalConnection);
$("#closePreferences").addEventListener("click", () => ui.preferencesDialog.close());
$("#cancelPreferences").addEventListener("click", () => ui.preferencesDialog.close());
$("#modelSearch").addEventListener("input", () => { renderSettingsModels(); $("#settingsModelList").scrollTop = 0; });
$("#preferencesForm").elements.defaultProvider.addEventListener("change", () => {
  const form = $("#preferencesForm");
  state.catalogProvider = form.elements.defaultProvider.value; $("#modelSearch").value = ""; state.catalogError = "";
  renderDefaultModel(form); renderProviderTabs(); renderSettingsModels();
  $("#settingsModelList").scrollTop = 0;
});
$("#preferencesForm").elements.defaultModel.addEventListener("change", () => {
  const form = $("#preferencesForm");
  renderDefaultModel(form, form.elements.defaultModel.value); renderSettingsModels();
});
document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
  tab.addEventListener("click", () => selectSettingsTab(tab.dataset.settingsTab));
});
for (const tablist of document.querySelectorAll(".settings-tabs, .provider-tabs")) {
  tablist.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...tablist.querySelectorAll('[role="tab"]')], current = tabs.indexOf(event.target);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const id = tabs[next].id; tabs[next].click(); document.getElementById(id)?.focus();
  });
}
$("#addSubagent").addEventListener("focus", syncAddSubagentMenu);
$("#addSubagent").addEventListener("change", (event) => {
  const choice = event.target.value;
  syncAddSubagentMenu();
  if (choice === "blank") addSubagentCards([{ access: "read-only" }]);
  else if (choice) addSubagentCards(subagentPresets().filter((preset) => preset.name === choice));
});
$("#addSubagentPresets").addEventListener("click", () => openSubagentModelDialog("add"));
$("#sameModelForAll").addEventListener("click", () => openSubagentModelDialog("apply"));
$("#preferencesForm").elements.agentsDelegation.addEventListener("input", renderDelegationLevel);
$("#subagentModelForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const choice = { provider: form.elements.provider.value, model: form.elements.model.value };
  if (form.dataset.mode === "add") addSubagentCards(subagentPresets().map((preset) => ({ ...preset, ...choice })), { keepModel: true });
  else { applyModelToCards($("#subagentList"), choice.provider, choice.model); syncOpenRouterWarning(); }
  $("#subagentModelDialog").close();
});
$("#closeSubagentModel").addEventListener("click", () => $("#subagentModelDialog").close());
$("#cancelSubagentModel").addEventListener("click", () => $("#subagentModelDialog").close());
$("#saveOpenrouterKey").addEventListener("click", () => { void saveOpenRouterKey(); });
$("#removeOpenrouterKey").addEventListener("click", () => { void saveOpenRouterKey(true); });
$("#openrouterKeyInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); void saveOpenRouterKey(); }
});
$("#agentsAddOpenrouterKey").addEventListener("click", () => {
  selectSettingsTab("models");
  state.catalogProvider = "openrouter"; renderProviderTabs(); renderSettingsModels();
  $("#openrouterKeyInput").focus();
});
$("#subagentList").addEventListener("change", (event) => { if (event.target.dataset.agentField === "provider") syncOpenRouterWarning(); });
$("#preferencesForm").elements.defaultProvider.addEventListener("change", () => syncOpenRouterWarning());
$("#preferencesForm").elements.memoryEnabled.addEventListener("change", () => syncGenerationControls());
$("#preferencesForm").elements.titleEnabled.addEventListener("change", () => syncGenerationControls());
$("#moreActions").addEventListener("click", async () => {
  const current = state.sessions.find((item) => item.sessionId === state.currentId);
  if (!current) return showToast("Choose a chat first.");
  try {
    await requestJson("/api/open-zed", { method: "POST", body: JSON.stringify({ cwd: current.cwd }) });
    showToast("Workspace opened in Zed");
  } catch (error) { showToast(error.message); }
});
$("#preferencesForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const saveButton = $("#savePreferences");
  if (saveButton.disabled || !state.modelSettingsReady) return;
  saveButton.disabled = true; saveButton.textContent = "Saving…";
  state.prefs = {
    theme: form.elements.theme.value,
    accent: form.elements.accent.value,
    showThoughts: form.elements.showThoughts.checked,
    jambalayaMode: form.elements.jambalayaMode.checked,
    usageMetric: form.elements.usageMetric.value
  };
  localStorage.setItem("unreal-console-prefs", JSON.stringify(state.prefs)); loadPrefs(); renderSessions(); renderTranscript();
  const currentSession = state.sessions.find((item) => item.sessionId === state.currentId);
  if (currentSession) ui.composerContext.textContent = `${basename(currentSession.cwd)} · ${displayModel(currentSession.currentModel)}`;
  try {
    const [capabilities, , generation, agents] = await Promise.all([
      requestJson("/api/capabilities", { method: "PUT", body: JSON.stringify({
        appleNotes: form.elements.appleNotes.checked,
        appleCalendar: form.elements.appleCalendar.checked
      }) }),
      requestJson("/api/default-model", { method: "PUT", body: JSON.stringify({ provider: form.elements.defaultProvider.value,
        model: form.elements.defaultModel.value, thoughtLevel: form.elements.defaultThoughtLevel.value }) }),
      requestJson("/api/generation-settings", { method: "PUT", body: JSON.stringify({
        memoryEnabled: form.elements.memoryEnabled.checked,
        memoryModel: form.elements.memoryModel.value,
        titleEnabled: form.elements.titleEnabled.checked,
        titleModel: form.elements.titleModel.value
      }) }),
      requestJson("/api/agents", { method: "PUT", body: JSON.stringify({
        enabled: form.elements.agentsEnabled.checked,
        maxConcurrent: Number(form.elements.agentsMaxConcurrent.value),
        delegation: Number(form.elements.agentsDelegation.value),
        swarm: { enabled: form.elements.swarmEnabled.checked, use: form.elements.swarmUse.value,
          size: Number(form.elements.swarmSize.value), maxMessages: Number(form.elements.swarmMessages.value) },
        subagents: collectSubagents($("#subagentList"))
      }) })
    ]);
    state.capabilities = capabilities.settings;
    state.generation = generation.settings;
    renderSubagents($("#subagentList"), agents.settings.subagents, state.modelProviders, syncSubagentControls);
    ui.preferencesDialog.close();
    showToast("Preferences saved");
  } catch (error) { showToast(error.message); }
  finally { saveButton.disabled = false; saveButton.textContent = "Save preferences"; }
});
$("#modelControl").addEventListener("click", (event) => { void openPicker("model", "Choose a model", "MODEL", event.currentTarget); });
$("#mobileControls").addEventListener("click", openMobileControls);
$("#permissionControl").addEventListener("click", (event) => { void openPicker("permission", "Set permissions", "ACCESS", event.currentTarget); });
$("#reasoningControl").addEventListener("click", (event) => { void openPicker("thought", "Reasoning effort", "THINKING", event.currentTarget); });
$("#usageControl").addEventListener("click", (event) => {
  if (state.openControl === event.currentTarget.id) closeControlPopover();
  else { openUsagePopover(event.currentTarget); void refreshSubscriptionUsage(state.currentProvider, { fresh: true });
    if (state.currentId) void refreshThreadUsageDetails(state.currentId); }
});
ui.liveState.addEventListener("click", toggleProgressPanel);
ui.timelineButton.addEventListener("click", toggleProgressPanel);
commandPanel = setupRunCommand({
  button: $("#commandButton"), panel: $("#commandPanel"), getSessionId: () => state.currentId, showToast,
  onOpen: () => { closeProgressPanel(); closeControlPopover(); },
  insertIntoMessage: (text) => {
    ui.prompt.value = ui.prompt.value.trim() ? `${ui.prompt.value.replace(/\s+$/, "")}\n\n${text}` : text;
    ui.prompt.dispatchEvent(new Event("input")); ui.prompt.focus();
  }
});
commandPanel.sync();
ui.liveProgressPanel.querySelector(".progress-turn-select").addEventListener("change", (event) => {
  state.selectedProgressTurn = Number(event.target.value); renderLiveProgress();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !ui.liveProgressPanel.hidden) { closeProgressPanel(); ui.timelineButton.focus(); }
});
document.addEventListener("pointerdown", (event) => {
  if (!ui.liveProgressPanel.hidden && !ui.liveProgressPanel.contains(event.target) && !ui.liveState.contains(event.target) && !ui.timelineButton.contains(event.target)) closeProgressPanel();
  if (state.openControl && !ui.controlStrip.contains(event.target)) closeControlPopover();
  if (ui.sidebar.classList.contains("open") && !ui.sidebar.contains(event.target) && !$("#mobileMenu").contains(event.target)) {
    ui.sidebar.classList.remove("open");
  }
});
ui.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  // Option/Alt+Enter holds a message until the running task ends; a plain send steers it.
  const queueOnly = state.queueNext; state.queueNext = false;
  if (state.submitting || state.creatingChat) return;
  const text = ui.prompt.value.trim();
  const attachedImages = state.attachments.map((image) => ({ ...image }));
  const attachments = attachedImages.map(({ mimeType, data }) => ({ mimeType, data }));
  if (!text && !attachments.length) return;
  state.submitting = true; state.taskError = "";
  renderTaskStatus(); updateSendAvailability();
  let sessionId = state.currentId;
  let localEntry;
  let inputId;
  try {
    if (!sessionId) {
      if (!state.currentProjectPath) throw new Error("Add or select a project before starting a chat.");
      sessionId = await startNewChat(state.currentProjectPath);
      if (!sessionId) return;
      ui.prompt.value = text;
      state.attachments = attachedImages; renderAttachments();
    }
    // Creating/selecting a chat opens its event stream asynchronously. Wait for
    // attachment to finish before sending, including the very first message.
    const connected = await state.configReady;
    if (state.currentId !== sessionId) return;
    if (connected === null || !state.ready) throw new Error("Could not connect to this chat. Your message is still here; try sending again.");
    const folderApproval = folderApprovalReply(state.entries, text, attachments);
    if (folderApproval) {
      await requestJson(`/api/sessions/${sessionId}/permission`, { method: "POST", body: JSON.stringify({ requestId: folderApproval.requestId, optionId: "allow-folders" }) });
      if (state.currentId === sessionId) {
        state.entries = state.entries.filter(entry => entry.requestId !== folderApproval.requestId);
        ui.prompt.value = ""; ui.prompt.style.height = "auto";
        renderTranscript();
        showToast("Folders approved; the agent will continue automatically.");
      }
      return;
    }
    ui.prompt.value = ""; ui.prompt.style.height = "auto";
    scrollFollow.follow();
    const wasRunning = state.running;
    if (!wasRunning || !queueOnly) {
      localEntry = messageEntry("user", `local-${Date.now()}`);
      localEntry.text = text; localEntry.images = attachedImages.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
      localEntry.localPending = true;
      state.running = true;
    }
    renderTranscript();
    inputId = recoverInputId(sessionId, text, attachments);
    const accepted = await requestJson(`/api/sessions/${sessionId}/prompt`, { method: "POST", body: JSON.stringify({ text, attachments, inputId, delivery: wasRunning ? (queueOnly ? "queue" : "steer") : "auto" }) });
    if (state.currentId === sessionId && accepted?.delivery === "queued" && localEntry) {
      state.entries = state.entries.filter(entry => entry !== localEntry);
      state.byMessage.delete(localEntry.id);
      state.running = state.promptRequests > 0;
      renderTranscript();
    }
    if (state.currentId === sessionId && accepted?.delivery === "steered" && localEntry) {
      localEntry.localPending = false;
      renderTranscript();
    }
    finishInputId(inputId);
    if (state.currentId === sessionId) { state.attachments = []; renderAttachments(); }
  } catch (error) {
    if (state.currentId === sessionId) {
      if (localEntry) {
        state.entries = state.entries.filter((entry) => entry !== localEntry);
        state.byMessage.delete(localEntry.id);
      }
      state.running = state.promptRequests > 0;
      if (!state.running && state.liveProgress?.endedAt === null) {
        state.progressTurns = state.progressTurns.filter((turn) => turn !== state.liveProgress);
        state.liveProgress = state.progressTurns.at(-1) || null;
      }
      ui.prompt.value = text;
      if (state.ready) state.taskError = error.message;
      state.attachments = attachedImages; renderAttachments(); renderTranscript();
    }
    showToast(error.message);
  } finally {
    state.submitting = false;
    renderTaskStatus(); updateSendAvailability();
  }
});
ui.stopTask.addEventListener("click", async () => {
  if (!state.currentId || !state.running) return;
  ui.stopTask.disabled = true; state.stopping = true; renderTranscript();
  try {
    await requestJson(`/api/sessions/${state.currentId}/cancel`, { method: "POST", body: "{}" });
    showToast("Stopping the current task");
  } catch (error) { state.stopping = false; showToast(error.message); renderTranscript(); }
  finally { ui.stopTask.disabled = false; }
});
ui.prompt.addEventListener("input", () => {
  ui.prompt.style.height = "auto"; ui.prompt.style.height = `${Math.min(ui.prompt.scrollHeight, 190)}px`; updateSendAvailability();
});
$("#attachImage").addEventListener("click", () => ui.imagePicker.click());
ui.imagePicker.addEventListener("change", () => { void addImageFiles([...ui.imagePicker.files]); ui.imagePicker.value = ""; });
let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault(); dragDepth += 1; ui.dropOverlay.classList.add("visible");
});
document.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); });
document.addEventListener("dragleave", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) ui.dropOverlay.classList.remove("visible");
});
document.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault(); dragDepth = 0; ui.dropOverlay.classList.remove("visible");
  if (!state.currentId && !state.currentProjectPath) return showToast("Choose a project before attaching images.");
  void addImageFiles([...event.dataTransfer.files]);
});
ui.prompt.addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.items || [])].filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
  if (images.length) { event.preventDefault(); void addImageFiles(images); }
});
setupKeyboardDismissal(ui.prompt, $("#hideKeyboard"));
ui.prompt.addEventListener("keydown", (event) => {
  // Let the on-screen keyboard insert a newline; the send button submits on touch devices.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !window.matchMedia("(pointer: coarse)").matches) {
    event.preventDefault(); state.queueNext = event.altKey && state.running; ui.composer.requestSubmit();
  }
});
$("#openChatSearch").addEventListener("click", openChatSearch);
$("#closeChatSearch").addEventListener("click", closeChatSearch);
ui.chatSearchDialog.addEventListener("close", () => {
  clearTimeout(chatSearchTimer); ++chatSearchRequest; chatSearchController?.abort();
});
ui.chatSearchInput.addEventListener("input", () => {
  clearTimeout(chatSearchTimer); ++chatSearchRequest; chatSearchController?.abort();
  ui.chatSearchResults.replaceChildren();
  ui.chatSearchStatus.textContent = ui.chatSearchInput.value.trim() ? "Searching…" : "Type to search your chats.";
  chatSearchTimer = setTimeout(runChatSearch, 250);
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); openChatSearch(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#newThread").click(); }
  if (event.key === "Escape") { closeProgressPanel(); closeControlPopover(); ui.sidebar.classList.remove("open"); }
});

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const register = (tool) => {
    try { void Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch {}
  };
  register({
    name: "list_unreal_agent_tasks", title: "List Unreal Agent tasks",
    description: "List the Unreal Agent tasks currently visible in this local console.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute() { return state.sessions.map(({ sessionId, title, cwd, busy, currentModel }) => ({ sessionId, title, cwd, busy, currentModel })); }
  });
  register({
    name: "open_unreal_agent_task", title: "Open Unreal Agent task",
    description: "Open an existing task in the visible console without sending a prompt.",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"], additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute(input) {
      if (!state.sessions.some((item) => item.sessionId === input?.sessionId)) throw new Error("Unknown task.");
      selectSession(input.sessionId); return { opened: true, sessionId: input.sessionId };
    }
  });
  register({
    name: "send_unreal_agent_prompt", title: "Send Unreal Agent prompt",
    description: "Send a prompt to the currently open Unreal Agent task. This starts model work and may incur usage cost.",
    inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!state.currentId) throw new Error("Open a task first.");
      const text = String(input?.text || "").trim(); if (!text) throw new Error("Prompt cannot be empty.");
      await requestJson(`/api/sessions/${state.currentId}/prompt`, { method: "POST", body: JSON.stringify({ text, inputId: newInputId() }) });
      return { accepted: true, sessionId: state.currentId };
    }
  });
}

loadPrefs(); loadPendingDrafts(); loadExpandedProjects(); loadSidebarOrder(); registerWebMcpTools(); refresh(); setInterval(refresh, 15000); setInterval(() => { if (state.currentId) void refreshSubscriptionUsage(state.currentProvider); }, 60_000);
setInterval(() => { if (ui.preferencesDialog.open && $("#dashboardTab").getAttribute("aria-selected") === "true") void refreshDashboard(); }, 30_000);

function compactCount(value) {
  const count = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Number((count / 1000).toFixed(count < 10_000 ? 1 : 0))}k`;
  return `${Number((count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0))}m`;
}

function formatCost(value) {
  if (!Number.isFinite(value)) return "Unavailable";
  return `$${value.toFixed(2)}`;
}

function formatEstimatedCost(value) {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

function formatSubscriptionIncrease(value) {
  return value === null ? "Unavailable" : `+${Number(value.toFixed(1))} pp`;
}

function formatQuota(window) {
  if (!Number.isFinite(window?.percent)) return "Unavailable";
  const reset = window.resetsAt && !Number.isNaN(Date.parse(window.resetsAt))
    ? ` · resets ${new Date(window.resetsAt).toLocaleString()}` : "";
  return `${Math.round(window.percent)}% used${reset}`;
}

function subscriptionProvider() {
  return ["claude-code", "openai-codex"].includes(state.currentProvider) ? state.currentProvider : null;
}

function renderUsageLabel() {
  const usage = state.usage;
  const provider = subscriptionProvider();
  const subscribed = provider && state.prefs.usageMetric !== "cost";
  const amount = usage.costKnown ? formatCost(usage.costAmount) : usage.hasUsage ? "Unavailable" : "$0.00";
  const quota = state.subscriptionUsage[provider];
  const label = subscribed ? (Number.isFinite(quota?.short?.percent) ? `${Math.round(quota.short.percent)}%` : "Unavailable") : amount;
  $("#usageMetricName").textContent = subscribed ? "Sub usage" : "Usage";
  $("#usageLabel").textContent = label;
  $("#usageControl").title = subscribed ? `${provider === "claude-code" ? "Claude" : "Codex"} subscription: ${formatQuota(quota?.short)} (5-hour window)`
    : `Usage: ${amount}; ${compactCount(usage.inputTokens + usage.outputTokens)} input and output tokens`;
  if (subscribed && state.subagentUsage?.apiResponses) $("#usageControl").title += `; subagent API charges ${formatCost(state.subagentUsage.apiCost)}`;
}

async function refreshSubscriptionUsage(provider, { fresh = false } = {}) {
  if (!["claude-code", "openai-codex"].includes(provider)) return;
  const request = ++state.subscriptionRequest;
  try {
    const quota = await requestJson(`/api/subscription-usage?provider=${encodeURIComponent(provider)}${fresh ? "&fresh=1" : ""}`);
    state.subscriptionUsage[provider] = quota;
    if (request === state.subscriptionRequest && state.currentProvider === provider) {
      renderUsageLabel();
      if (state.openControl === "usageControl") openUsagePopover($("#usageControl"));
    }
    renderSettingsSubscriptionUsage();
  } catch { /* The cost and token metrics remain available offline. */ }
}

function renderSettingsSubscriptionUsage() {
  const container = $("#subscriptionSettings");
  if (!container) return;
  container.replaceChildren();
  for (const [provider, name] of [["openai-codex", "Codex"], ["claude-code", "Claude"]]) {
    const cell = document.createElement("div"); cell.className = "usage-stat";
    const label = document.createElement("span"); label.textContent = `${name} · 5 hours / 7 days`;
    const value = document.createElement("strong");
    const quota = state.subscriptionUsage[provider];
    value.textContent = `${formatQuota(quota?.short)} / ${formatQuota(quota?.long)}`;
    cell.append(label, value); container.append(cell);
  }
}

async function refreshSettingsSubscriptionUsage() {
  renderSettingsSubscriptionUsage();
  await Promise.all(["openai-codex", "claude-code"].map((provider) => refreshSubscriptionUsage(provider)));
}

function resetUsage(current = {}) {
  state.subagentUsage = null;
  const cost = current.costAmount ?? current.cost?.amount;
  state.usage = {
    inputTokens: Number.isSafeInteger(current.inputTokens) ? current.inputTokens : 0,
    outputTokens: Number.isSafeInteger(current.outputTokens) ? current.outputTokens : 0,
    cachedReadTokens: Number.isSafeInteger(current.cachedReadTokens) ? current.cachedReadTokens : 0,
    cachedWriteTokens: Number.isSafeInteger(current.cachedWriteTokens) ? current.cachedWriteTokens : 0,
    thoughtTokens: Number.isSafeInteger(current.thoughtTokens) ? current.thoughtTokens : 0,
    costAmount: Number.isFinite(cost) ? cost : null,
    costKnown: Number.isFinite(cost),
    used: Number.isFinite(current.used) ? current.used : 0,
    size: Number.isFinite(current.size) ? current.size : 0,
    hasUsage: Number.isFinite(cost) || (current.inputTokens || 0) + (current.outputTokens || 0) > 0
  };
  renderUsageLabel();
}

function updateUsage(update) {
  const usage = state.usage;
  const details = update._meta?.["unreal-agent/usage"] || update.usage || {};
  for (const key of ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens"]) {
    if (Number.isSafeInteger(details[key]) && details[key] >= 0) usage[key] = details[key];
  }
  const cost = update.costAmount ?? update.cost?.amount;
  if (Number.isFinite(cost)) { usage.costAmount = cost; usage.costKnown = true; }
  else if (Object.hasOwn(update, "cost") && update.cost === null) { usage.costAmount = null; usage.costKnown = false; }
  if (Number.isFinite(update.used)) usage.used = update.used;
  if (Number.isFinite(update.size) && update.size > 0) usage.size = update.size;
  else if (state.usageReference?.contextWindow) usage.size = state.usageReference.contextWindow;
  usage.hasUsage ||= usage.inputTokens + usage.outputTokens > 0 || usage.costKnown;
  renderUsageLabel();
  if (state.openControl === "usageControl") openUsagePopover($("#usageControl"));

}
setInterval(() => { renderLiveProgress(); tickSubagentTimers(ui.messages); }, 1000);
