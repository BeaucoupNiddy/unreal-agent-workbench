import { renderMarkdown } from "./markdown.js";
import { applyModelFavorites } from "./favorites.js";
import { activitySummary, groupTranscriptEntries } from "./activity.js";
import { appendMessageChunk } from "./transcript.js";
import { moveId, moveIdBy, orderedByIds } from "./sidebar-order.js";

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
  entries: [], byMessage: new Map(), byTool: new Map(), running: false, promptRequests: 0, creatingChat: false, submitting: false, attachments: [],
  pendingDeleteId: null, deletingChat: false, pendingProjectId: null, editingProjectId: null, editingProjectPath: null, editingLegacyProject: false, deletingProject: false,
  capabilities: { appleNotes: true, appleCalendar: true },
  generation: { memoryEnabled: true, memoryModel: "gpt-6-luna", titleEnabled: true, titleModel: "gpt-6-luna" },
  generationModels: [],
  localPresets: [], editingLocalProvider: null, localProviderBusy: false,
  modelProviders: [], catalogProvider: null, catalogLoading: false, refreshingModels: false, catalogError: "", modelSettingsReady: false, preferencesLoadId: 0,
  configReady: null, resolveConfigReady: null, configReadyTimeout: null,
  openActivityGroups: new Set(),
  openControl: null,
  usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, costAmount: null, costKnown: false, used: 0, size: 0 },
  prefs: { theme: "system", accent: "lime", showThoughts: true, jambalayaMode: false }
};

const ui = {
  sidebar: $("#sidebar"), sessionList: $("#sessionList"), sessionCount: $("#sessionCount"),
  taskTitle: $("#taskTitle"), taskPath: $("#taskPath"), liveState: $("#liveState"),
  emptyState: $("#emptyState"), messages: $("#messages"), prompt: $("#prompt"),
  composer: $("#composer"), composerContext: $("#composerContext"), toast: $("#toast"), stopTask: $("#stopTask"),
  attachmentList: $("#attachmentList"), imagePicker: $("#imagePicker"), dropOverlay: $("#dropOverlay"),
  conversation: $("#conversation"), controlStrip: $("#controlStrip"), controlPopover: $("#controlPopover"),
  preferencesDialog: $("#preferencesDialog"), deleteChatDialog: $("#deleteChatDialog"),
  deleteChatTitle: $("#deleteChatTitle"), deleteChatCopy: $("#deleteChatCopy"), confirmDeleteChat: $("#confirmDeleteChat"),
  projectDialog: $("#projectDialog"), deleteProjectDialog: $("#deleteProjectDialog")
};

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
function setConnection(ready, label) {
  state.ready = ready;
  ui.liveState.className = `live-state ${ready ? "ready" : "offline"}`;
  ui.liveState.querySelector("span").textContent = label;
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
  state.currentProjectPath = folderPath; state.currentId = null;
  try { localStorage.setItem("unreal-console-project", folderPath); } catch {}
  state.stream?.close(); state.stream = null;
  state.resolveConfigReady?.(null); state.resolveConfigReady = null; clearTimeout(state.configReadyTimeout);
  state.configReadyTimeout = null; state.configReady = null;
  ui.prompt.value = ""; ui.prompt.disabled = false; ui.prompt.style.height = "auto";
  state.attachments = []; renderAttachments();
  $("#attachImage").disabled = false;
  for (const control of ["#modelControl", "#permissionControl", "#reasoningControl", "#usageControl"]) $(control).disabled = false;
  $("#moreActions").disabled = true;
  resetUsage();
  ui.sidebar.classList.remove("open");
  ui.taskTitle.textContent = project.name; ui.taskPath.textContent = project.path;
  ui.composerContext.textContent = "Write a message to start a new chat";
  $("#welcomeTitle").textContent = project.name;
  $("#welcomeCopy").textContent = "Type below to start a chat. Your conversations will stay grouped here and use this folder as their workspace.";
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
  state.currentProjectPath = null; state.currentId = null;
  state.stream?.close(); state.stream = null;
  state.resolveConfigReady?.(null); state.resolveConfigReady = null; clearTimeout(state.configReadyTimeout);
  state.configReadyTimeout = null; state.configReady = null;
  ui.prompt.value = ""; ui.prompt.disabled = true; ui.prompt.style.height = "auto";
  state.attachments = []; renderAttachments();
  $("#attachImage").disabled = true;
  for (const control of ["#modelControl", "#permissionControl", "#reasoningControl", "#usageControl"]) $(control).disabled = true;
  $("#moreActions").disabled = true;
  resetUsage();
  ui.sidebar.classList.remove("open");
  ui.taskTitle.textContent = "Select a project"; ui.taskPath.textContent = "Add a folder to organize your chats.";
  ui.composerContext.textContent = "Select a task to begin";
  $("#welcomeTitle").innerHTML = "Your work,<br /><em>without the clutter.</em>";
  $("#welcomeCopy").textContent = "Add a project folder to get started. Each project keeps its chats together.";
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

function resetTranscript() {
  state.entries = []; state.byMessage.clear(); state.byTool.clear(); state.configOptions = []; state.running = false; state.promptRequests = 0;
  state.openActivityGroups.clear();
  renderTranscript();
}

function selectSession(id) {
  if (state.currentId === id && state.stream) return;
  const item = state.sessions.find((session) => session.sessionId === id);
  if (!item) { showToast("This chat is not available yet. Refresh the project and try again."); return; }
  closeControlPopover();
  state.currentId = id;
  const project = projectForSession(item);
  state.currentProjectPath = project?.path || null;
  if (project) setProjectExpanded(project.path, true);
  ui.prompt.value = ""; ui.prompt.style.height = "auto"; state.attachments = []; renderAttachments();
  ui.prompt.disabled = false; $("#attachImage").disabled = false;
  renderSessions();
  ui.taskTitle.textContent = item.title || "Untitled chat"; ui.taskPath.textContent = item.cwd || "Local workspace";
  ui.composer.querySelector(".send-button").disabled = false;
  for (const control of ["#modelControl", "#permissionControl", "#reasoningControl", "#usageControl", "#moreActions"]) $(control).disabled = false;
  ui.composerContext.textContent = `${basename(item.cwd)} · ${displayModel(item.currentModel)}`;
  $("#modelLabel").textContent = (item.currentModel || "Model").split("/").pop();
  resetUsage(item.currentUsage);
  ui.sidebar.classList.remove("open"); resetTranscript(); connectStream(id);
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
  stream.addEventListener("ready", (event) => {
    const data = JSON.parse(event.data); state.modelFavorites = data.modelFavorites || [];
    state.configOptions = applyModelFavorites(data.configOptions || [], state.modelFavorites);
    applyConfigLabels(); setConnection(true, "Live with Hydra"); renderTranscript(); settleConfigReady(state.configOptions);
  });
  stream.addEventListener("hydra", (event) => handleHydra(JSON.parse(event.data)));
  stream.addEventListener("permission", (event) => addPermission(JSON.parse(event.data)));
  stream.addEventListener("console", (event) => handleConsole(JSON.parse(event.data)));
  stream.addEventListener("fault", (event) => {
    const data = JSON.parse(event.data); showToast(data.error); setConnection(false, "Task unavailable"); settleConfigReady(null);
  });
  stream.onerror = () => setConnection(false, "Reconnecting");
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
  const update = message.params?.update || {};
  const kind = update.sessionUpdate;
  if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
    const role = kind.startsWith("user") ? "user" : "agent";
    appendMessageChunk(state.entries, state.byMessage, {
      role, id: update.messageId, text: textFrom(update.content), images: imagesFrom(update.content)
    });
  } else if (kind === "agent_thought_chunk") {
    const id = `thought-${update.messageId || "current"}`;
    let entry = state.byMessage.get(id);
    if (!entry) { entry = { type: "thought", id, text: "" }; state.byMessage.set(id, entry); state.entries.push(entry); }
    entry.text += textFrom(update.content);
  } else if (kind === "tool_call") {
    const entry = { type: "tool", id: update.toolCallId, title: update.title || update.kind || "Tool", kind: update.kind, status: update.status || "pending", input: update.rawInput, output: "" };
    state.byTool.set(update.toolCallId, entry); state.entries.push(entry);
  } else if (kind === "tool_call_update") {
    let entry = state.byTool.get(update.toolCallId);
    if (!entry) { entry = { type: "tool", id: update.toolCallId, title: "Tool activity", status: "pending", output: "" }; state.byTool.set(update.toolCallId, entry); state.entries.push(entry); }
    entry.status = update.status || entry.status; entry.output = textFrom(update.content) || textFrom(update.rawOutput?.output) || entry.output;
  } else if (kind === "usage_update") {
    updateUsage(update);
  } else if (kind === "config_option_update") {
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
    state.running = false;
  } else if (kind === "prompt_received") {
    state.running = true;
  }
  renderTranscript();
}

function handleConsole(event) {
  if (event.kind === "prompt_started") state.promptRequests += 1;
  else if (event.kind === "prompt_complete") state.promptRequests = Math.max(0, state.promptRequests - 1);
  else if (event.kind === "prompt_error") {
    state.promptRequests = Math.max(0, state.promptRequests - 1);
    showToast(event.error);
  }
  state.running = state.promptRequests > 0;
  renderTranscript();
}

function addPermission(data) {
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

function renderTranscript() {
  ui.messages.replaceChildren();
  const visible = groupTranscriptEntries(state.entries, state.prefs.showThoughts);
  ui.emptyState.hidden = visible.length > 0;
  ui.messages.hidden = visible.length === 0;
  for (const entry of visible) {
    if (entry.type === "message") {
      const article = document.createElement("article"); article.className = `turn ${entry.role}`;
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
      ui.messages.append(article);
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
          thought.innerHTML = `<strong>Reasoning</strong><p>${escapeHtml(item.text)}</p>`;
          list.append(thought);
        } else {
          const toolCard = document.createElement("div"); toolCard.className = "event-card";
          const toolStatus = item.status === "pending" || item.status === "in_progress" ? "running" : item.status;
          toolCard.innerHTML = `<div class="event-card-header"><span class="event-icon">${item.kind === "edit" ? "✎" : "›_"}</span><span class="event-title">${escapeHtml(item.title)}</span><span class="event-status ${escapeHtml(toolStatus)}">${escapeHtml(toolStatus)}</span></div><pre class="event-output">${escapeHtml(toolOutput(item))}</pre>`;
          list.append(toolCard);
        }
      }
      activity.append(summary, list);
      activity.addEventListener("toggle", () => {
        if (activity.open) state.openActivityGroups.add(entry.id);
        else state.openActivityGroups.delete(entry.id);
      });
      ui.messages.append(activity);
    } else if (entry.type === "permission") {
      const card = document.createElement("div"); card.className = "permission-card";
      const request = entry.request; const options = request.options || request.permissionOptions || [];
      card.innerHTML = `<strong>Permission needed</strong><p>${escapeHtml(request.toolCall?.title || request.title || `${brand().name} needs approval to continue.`)}</p><div class="permission-actions"></div>`;
      const actions = card.querySelector(".permission-actions");
      for (const option of options) {
        const button = document.createElement("button"); button.textContent = option.name || option.label || option.optionId;
        button.addEventListener("click", () => answerPermission(entry, option.optionId)); actions.append(button);
      }
      ui.messages.append(card);
    }
  }
  if (state.running) {
    const run = document.createElement("div"); run.className = "run-state"; run.innerHTML = `<i></i><span>${brand().name} is working</span>`; ui.messages.append(run);
  }
  const sendButton = ui.composer.querySelector(".send-button");
  sendButton.textContent = "↑";
  sendButton.setAttribute("aria-label", state.running ? "Send steering message" : "Send");
  sendButton.title = state.running ? "Send a message to steer the active task" : "Send message";
  ui.stopTask.hidden = !state.running;
  updateSendAvailability();
  requestAnimationFrame(() => { ui.conversation.scrollTop = ui.conversation.scrollHeight; });
}

async function answerPermission(entry, optionId) {
  try {
    await requestJson(`/api/sessions/${state.currentId}/permission`, { method: "POST", body: JSON.stringify({ requestId: entry.requestId, optionId }) });
    state.entries = state.entries.filter((item) => item !== entry); renderTranscript();
  } catch (error) { showToast(error.message); }
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
  if (model) $("#modelLabel").textContent = modelControlLabel(model) || "Model";
  if (permission) $("#permissionLabel").textContent = displayValue(permission) || "Workspace";
  if (thought) $("#reasoningLabel").textContent = displayValue(thought) || "Medium";
}

function closeControlPopover() {
  if (ui.controlPopover.hidden) return;
  ui.controlPopover.hidden = true;
  ui.controlPopover.replaceChildren();
  ui.controlPopover.style.removeProperty('left');
  for (const id of ['modelControl', 'permissionControl', 'reasoningControl', 'usageControl']) {
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
  });
  return popover;
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
  if (search) requestAnimationFrame(() => search.focus());
}

function openUsagePopover(anchor) {
  const popover = showControlPopover(anchor, 'Conversation usage', 'USAGE');
  const usage = state.usage;
  const cachedPercent = usage.inputTokens > 0 ? `${Math.round(100 * usage.cachedReadTokens / usage.inputTokens)}%` : '0%';
  const rows = [
    ['Total cost', usage.costKnown ? formatCost(usage.costAmount) : usage.hasUsage ? 'Unavailable' : '$0.00'],
    ['Input tokens', compactCount(usage.inputTokens)],
    ['Output tokens', compactCount(usage.outputTokens)],
    ['Total tokens', compactCount(usage.inputTokens + usage.outputTokens)],
    ['Cached input', `${compactCount(usage.cachedReadTokens)} · ${cachedPercent} of input`],
    ['Cache written', compactCount(usage.cachedWriteTokens)],
    ['Reasoning tokens', compactCount(usage.thoughtTokens)]
  ];
  const grid = document.createElement('div'); grid.className = 'usage-stats';
  for (const [label, value] of rows) {
    const cell = document.createElement('div'); cell.className = 'usage-stat';
    const name = document.createElement('span'); name.textContent = label;
    const amount = document.createElement('strong'); amount.textContent = value;
    cell.append(name, amount); grid.append(cell);
  }
  popover.append(grid);
  const context = document.createElement('p'); context.className = 'usage-context';
  context.textContent = usage.size > 0
    ? `Latest context: ${compactCount(usage.used)} / ${compactCount(usage.size)} tokens (${Math.round(100 * usage.used / usage.size)}%).`
    : 'Context window details are not reported for this model.';
  popover.append(context);
  const note = document.createElement('p'); note.className = 'popover-hint usage-note';
  note.textContent = 'Cached reads are included in input. Cost is shown only when the provider reports an actual charge.';
  popover.append(note);
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
  try {
    const result = await requestJson(`/api/sessions/${state.currentId}/config`, { method: 'POST', body: JSON.stringify({ configId, value }) });
    state.configOptions = result.configOptions || state.configOptions;
    const option = state.configOptions.find((item) => item.id === configId); if (option) option.currentValue = value;
    applyConfigLabels(); closeControlPopover(); showToast('Task setting updated');
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
  $("#defaultModelHint").textContent = missing
    ? "Your saved model is no longer listed. Choose another model, or new chats will use the provider default."
    : provider?.local && !choices.length ? "Start the local server or add a model ID before starting a new chat." : "Existing chats keep their provider and model.";
}

function selectSettingsTab(name) {
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
  $("#localConnectionAddress").textContent = provider?.local ? provider.baseUrl : "";
  $("#addLocalProvider").disabled = !state.modelSettingsReady;
  $("#modelCatalogCount").textContent = provider ? search ? `${models.length} of ${provider.models.length} models` : `${provider.models.length} available models` : "";
  syncRefreshModels();
}

async function openPreferences() {
  if (ui.preferencesDialog.open) return;
  const loadId = ++state.preferencesLoadId, form = $("#preferencesForm");
  state.modelSettingsReady = false; state.catalogLoading = true; state.catalogError = "";
  form.elements.defaultProvider.disabled = true; form.elements.defaultModel.disabled = true;
  form.elements.theme.value = state.prefs.theme; form.elements.accent.value = state.prefs.accent;
  form.elements.jambalayaMode.checked = state.prefs.jambalayaMode;
  form.elements.showThoughts.checked = state.prefs.showThoughts;
  $("#modelSearch").value = ""; $("#savePreferences").disabled = true;
  selectSettingsTab("models"); renderSettingsModels(); ui.preferencesDialog.showModal();
  const results = await Promise.allSettled([
    requestJson("/api/capabilities"), requestJson("/api/generation-settings"),
    requestJson("/api/default-model"), requestJson("/api/models")
  ]);
  if (loadId !== state.preferencesLoadId) return;
  const [capabilities, generation, defaults, catalog] = results;
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
  $("#settingsModelList").scrollTop = 0;
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

function syncGenerationControls(form = $("#preferencesForm")) {
  form.elements.memoryModel.disabled = !form.elements.memoryEnabled.checked;
  form.elements.titleModel.disabled = !form.elements.titleEnabled.checked;
}

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
    selectSession(sessionId);
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
          $("#welcomeCopy").textContent = "Type below to start a chat. Your conversations will stay grouped here and use this folder as their workspace.";
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
    jambalayaMode: form.elements.jambalayaMode.checked
  };
  localStorage.setItem("unreal-console-prefs", JSON.stringify(state.prefs)); loadPrefs(); renderSessions(); renderTranscript();
  const currentSession = state.sessions.find((item) => item.sessionId === state.currentId);
  if (currentSession) ui.composerContext.textContent = `${basename(currentSession.cwd)} · ${displayModel(currentSession.currentModel)}`;
  try {
    const [capabilities, , generation] = await Promise.all([
      requestJson("/api/capabilities", { method: "PUT", body: JSON.stringify({
        appleNotes: form.elements.appleNotes.checked,
        appleCalendar: form.elements.appleCalendar.checked
      }) }),
      requestJson("/api/default-model", { method: "PUT", body: JSON.stringify({ provider: form.elements.defaultProvider.value, model: form.elements.defaultModel.value }) }),
      requestJson("/api/generation-settings", { method: "PUT", body: JSON.stringify({
        memoryEnabled: form.elements.memoryEnabled.checked,
        memoryModel: form.elements.memoryModel.value,
        titleEnabled: form.elements.titleEnabled.checked,
        titleModel: form.elements.titleModel.value
      }) })
    ]);
    state.capabilities = capabilities.settings;
    state.generation = generation.settings;
    ui.preferencesDialog.close();
    showToast("Preferences saved");
  } catch (error) { showToast(error.message); }
  finally { saveButton.disabled = false; saveButton.textContent = "Save preferences"; }
});
$("#modelControl").addEventListener("click", (event) => { void openPicker("model", "Choose a model", "MODEL", event.currentTarget); });
$("#permissionControl").addEventListener("click", (event) => { void openPicker("permission", "Set permissions", "ACCESS", event.currentTarget); });
$("#reasoningControl").addEventListener("click", (event) => { void openPicker("thought", "Reasoning effort", "THINKING", event.currentTarget); });
$("#usageControl").addEventListener("click", (event) => {
  if (state.openControl === event.currentTarget.id) closeControlPopover();
  else openUsagePopover(event.currentTarget);
});
document.addEventListener("pointerdown", (event) => {
  if (state.openControl && !ui.controlStrip.contains(event.target)) closeControlPopover();
  if (ui.sidebar.classList.contains("open") && !ui.sidebar.contains(event.target) && !$("#mobileMenu").contains(event.target)) {
    ui.sidebar.classList.remove("open");
  }
});
ui.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.submitting || state.creatingChat) return;
  const text = ui.prompt.value.trim();
  const attachedImages = state.attachments.map((image) => ({ ...image }));
  const attachments = attachedImages.map(({ mimeType, data }) => ({ mimeType, data }));
  if (!text && !attachments.length) return;
  state.submitting = true;
  updateSendAvailability();
  let sessionId = state.currentId;
  let localEntry;
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
    ui.prompt.value = ""; ui.prompt.style.height = "auto";
    localEntry = messageEntry("user", `local-${Date.now()}`);
    localEntry.text = text; localEntry.images = attachedImages.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
    localEntry.localPending = true;
    state.running = true; renderTranscript();
    await requestJson(`/api/sessions/${sessionId}/prompt`, { method: "POST", body: JSON.stringify({ text, attachments }) });
    if (state.currentId === sessionId) { state.attachments = []; renderAttachments(); }
  } catch (error) {
    if (state.currentId === sessionId) {
      if (localEntry) {
        state.entries = state.entries.filter((entry) => entry !== localEntry);
        state.byMessage.delete(localEntry.id);
      }
      state.running = state.promptRequests > 0; ui.prompt.value = text;
      state.attachments = attachedImages; renderAttachments(); renderTranscript();
    }
    showToast(error.message);
  } finally {
    state.submitting = false;
    updateSendAvailability();
  }
});
ui.stopTask.addEventListener("click", async () => {
  if (!state.currentId || !state.running) return;
  ui.stopTask.disabled = true;
  try {
    await requestJson(`/api/sessions/${state.currentId}/cancel`, { method: "POST", body: "{}" });
    showToast("Stopping the current task");
  } catch (error) { showToast(error.message); }
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
ui.prompt.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); ui.composer.requestSubmit(); } });
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#newThread").click(); }
  if (event.key === "Escape") { closeControlPopover(); ui.sidebar.classList.remove("open"); }
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
      await requestJson(`/api/sessions/${state.currentId}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
      return { accepted: true, sessionId: state.currentId };
    }
  });
}

loadPrefs(); loadPendingDrafts(); loadExpandedProjects(); loadSidebarOrder(); registerWebMcpTools(); refresh(); setInterval(refresh, 15000);

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

function renderUsageLabel() {
  const usage = state.usage;
  const amount = usage.costKnown ? formatCost(usage.costAmount) : usage.hasUsage ? "Unavailable" : "$0.00";
  const tokens = usage.inputTokens + usage.outputTokens;
  $("#usageLabel").textContent = amount;
  $("#usageControl").title = `Usage: ${amount}; ${compactCount(tokens)} input and output tokens`;
}

function resetUsage(current = {}) {
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
  if (Number.isFinite(update.size)) usage.size = update.size;
  usage.hasUsage ||= usage.inputTokens + usage.outputTokens > 0 || usage.costKnown;
  renderUsageLabel();
  if (state.openControl === "usageControl") openUsagePopover($("#usageControl"));

}
