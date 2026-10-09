// Subagent task cards. The bridge sends each delegation as a tool call whose
// _meta["unreal-agent/subagent"] holds its live state; this turns those updates
// into transcript entries and draws them.
import { renderMarkdown } from "./markdown.js";

export const subagentMetaKey = "unreal-agent/subagent";
export const swarmMetaKey = "unreal-agent/swarm";
const delegateCommand = /unreal-capability['"]?\s+(?:['"])?(?:delegate|swarm)\b/;

export function isSubagentUpdate(update) {
  return Boolean(update?._meta?.[subagentMetaKey] || update?._meta?.[swarmMetaKey]);
}

// The primary agent's `unreal-capability delegate` command. Its output repeats
// the subagent's report, so the card replaces it once the command succeeds.
export function isDelegateCommand(update) {
  const input = update?.rawInput;
  const command = typeof input === "string" ? input : input?.command ?? input?.cmd ?? "";
  return delegateCommand.test(Array.isArray(command) ? command.join(" ") : String(command)) || delegateCommand.test(String(update?.title || ""));
}

const textOf = (content) => (Array.isArray(content) ? content : [content]).map((item) => item?.content?.text ?? item?.text ?? "").join("");

export function upsertSubagent(entries, byId, update) {
  const swarm = update._meta[swarmMetaKey];
  const state = swarm || update._meta[subagentMetaKey];
  let entry = byId.get(update.toolCallId);
  if (!entry) {
    entry = { type: swarm ? "swarm" : "subagent", id: update.toolCallId, state: {}, report: "" };
    byId.set(update.toolCallId, entry); entries.push(entry);
  }
  entry.state = { ...entry.state, ...state };
  const text = update.content ? textOf(update.content) : "";
  if (text) entry.report = text;
  return entry;
}

export function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function compactTokens(value) {
  const tokens = Number(value) || 0;
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${Number((tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0))}k`;
  return `${Number((tokens / 1_000_000).toFixed(1))}m`;
}

const statusLabels = { running: "Running", completed: "Done", failed: "Failed", cancelled: "Stopped" };

export function elapsedFor(state, now = Date.now()) {
  return formatElapsed((state.endedAt || now) - (state.startedAt || now));
}

// One line of facts under each card: steps, tokens, dollars, time.
export function subagentFacts(state) {
  const facts = [];
  if (state.stepCount) facts.push(`${state.stepCount} ${state.stepCount === 1 ? "step" : "steps"}`);
  const tokens = (state.inputTokens || 0) + (state.outputTokens || 0);
  if (tokens) facts.push(`${compactTokens(tokens)} tokens`);
  if (Number.isFinite(state.cost)) facts.push(`$${state.cost.toFixed(state.cost > 0 && state.cost < 0.01 ? 4 : 2)}`);
  return facts;
}

export function groupSummary(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.state.status] = (counts[entry.state.status] || 0) + 1;
  const parts = [`${entries.length} subagents`];
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.completed) parts.push(`${counts.completed} done`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.cancelled) parts.push(`${counts.cancelled} stopped`);
  return parts.join(" · ");
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stepRow(step) {
  const row = element("li", `subagent-step ${step.status}`);
  row.append(element("span", "subagent-step-icon"), element("span", "subagent-step-title", step.title));
  return row;
}

export function renderSubagentCard(entry, { open = false, onToggle = () => {} } = {}) {
  const state = entry.state;
  const status = statusLabels[state.status] ? state.status : "running";
  const card = element("article", `subagent-card-view ${status}`);
  card.dataset.subagentId = entry.id;
  card.toggleAttribute("data-open", open);
  const head = element("button", "subagent-head");
  head.type = "button";
  head.setAttribute("aria-expanded", String(open));
  const badge = element("span", "subagent-badge", (state.name || "Subagent").slice(0, 1).toUpperCase());
  const title = element("span", "subagent-title");
  title.append(element("strong", "", state.name || "Subagent"));
  const chips = element("span", "subagent-chips");
  if (state.model) chips.append(element("span", "subagent-chip", state.model));
  chips.append(element("span", "subagent-chip", state.access === "workspace-write" ? "can edit" : "read only"));
  title.append(chips);
  const statusLabel = element("span", `subagent-status ${status}`);
  statusLabel.append(element("i"), element("span", "", statusLabels[status]));
  const elapsed = element("span", "subagent-elapsed", elapsedFor(state));
  if (status === "running") elapsed.dataset.subagentStarted = String(state.startedAt || Date.now());
  head.append(badge, title, statusLabel, elapsed, element("span", "subagent-chevron", "›"));

  const body = element("div", "subagent-body");
  body.append(element("p", "subagent-task", state.task || ""));
  const steps = state.steps || [];
  if (steps.length) {
    // Closed cards show the latest three steps; open cards show every step kept.
    const list = element("ol", "subagent-steps");
    const total = Math.max(state.stepCount || 0, steps.length);
    if (total > 3) list.append(element("li", "subagent-more", `${total - 3} earlier ${total - 3 === 1 ? "step" : "steps"}`));
    steps.forEach((step, index) => {
      const row = stepRow(step);
      if (index < steps.length - 3) row.classList.add("older");
      list.append(row);
    });
    body.append(list);
  }
  if (status === "running" && state.activity) body.append(element("p", "subagent-activity", state.activity));
  const footer = element("div", "subagent-footer");
  footer.append(element("span", "subagent-facts", subagentFacts(state).join(" · ") || (status === "running" ? "Starting…" : "")));
  const detail = element("div", "subagent-detail");
  if (state.error && status !== "completed") detail.append(element("p", "subagent-error", state.error));
  else if (entry.report) {
    const report = element("div", "subagent-report message-content");
    report.innerHTML = renderMarkdown(entry.report);
    detail.append(element("h6", "", "Report"), report);
  }
  if (detail.childElementCount) {
    footer.append(element("span", "subagent-hint show", status === "completed" ? "Show report" : "Show details"),
      element("span", "subagent-hint hide", "Hide"));
  }
  body.append(footer);
  card.append(head, body, detail);
  const toggle = () => {
    const next = !card.hasAttribute("data-open");
    card.toggleAttribute("data-open", next);
    head.setAttribute("aria-expanded", String(next));
    onToggle(next);
  };
  head.addEventListener("click", toggle);
  footer.addEventListener("click", toggle);
  return card;
}

export function swarmSummary(state) {
  const members = state.members || [];
  const parts = [`Swarm · ${members.length} members`];
  const messages = state.messageCount || 0;
  parts.push(`${messages} ${messages === 1 ? "message" : "messages"}`);
  const running = members.filter((member) => member.status === "running").length;
  if (state.status === "running" && running) parts.push(`${running} working`);
  else if (state.status !== "running") parts.push(statusLabels[state.status] || state.status);
  return parts.join(" · ");
}

// The swarm's header: task, and the conversation between members as it happens.
export function renderSwarmHead(entry, { open = true, onToggle = () => {} } = {}) {
  const state = entry.state;
  const head = element("div", "swarm-head");
  const line = element("div", "subagent-group-head");
  line.append(element("span", `subagent-group-dot${state.status === "running" ? " running" : ""}`), element("span", "", swarmSummary(state)));
  head.append(line, element("p", "swarm-task", state.task || ""));
  const messages = state.messages || [];
  if (messages.length) {
    const feed = element("details", "swarm-feed");
    feed.open = open;
    const hidden = (state.messageCount || 0) - messages.length;
    feed.append(element("summary", "", `Discussion between agents${hidden > 0 ? ` (latest ${messages.length})` : ""}`));
    const list = element("ol", "swarm-messages");
    for (const message of messages) {
      const row = element("li", "swarm-message");
      row.append(element("span", "swarm-from", `${message.from} → ${message.to === "all" ? "all" : message.to}`), element("span", "swarm-text", message.text));
      list.append(row);
    }
    feed.append(list);
    feed.addEventListener("toggle", () => onToggle(feed.open));
    head.append(feed);
  }
  return head;
}

export function renderSubagentGroup(group, options, swarmOptions) {
  const wrapper = element("section", "subagent-group");
  wrapper.setAttribute("aria-label", group.swarm ? "Swarm" : "Subagents");
  if (group.swarm) wrapper.append(renderSwarmHead(group.swarm, swarmOptions));
  else if (group.entries.length > 1) {
    const header = element("div", "subagent-group-head");
    const running = group.entries.some((entry) => entry.state.status === "running");
    header.append(element("span", `subagent-group-dot${running ? " running" : ""}`), element("span", "", groupSummary(group.entries)));
    wrapper.append(header);
  }
  for (const entry of group.entries) wrapper.append(renderSubagentCard(entry, options(entry)));
  return wrapper;
}

// Keeps running timers current between transcript renders.
export function tickSubagentTimers(root, now = Date.now()) {
  for (const node of root.querySelectorAll("[data-subagent-started]")) {
    node.textContent = formatElapsed(now - Number(node.dataset.subagentStarted));
  }
}
