// Pure helpers for running one delegated subagent task. The bridge owns
// process launch, sandboxing, cancellation, and usage accounting.
export const maximumSubagentReportCharacters = 8000;
export const maximumSubagentTaskCharacters = 20000;

export function normalizeDelegation(request = {}) {
  const agent = typeof request.agent === "string" ? request.agent.trim() : "";
  const task = typeof request.task === "string" ? request.task.trim() : "";
  const context = typeof request.context === "string" ? request.context.trim() : "";
  if (!agent) throw new Error("Name the subagent to use, for example {\"agent\":\"explorer\",\"task\":\"...\"}.");
  if (!task) throw new Error("Describe the subagent's task.");
  if (task.length + context.length > maximumSubagentTaskCharacters) throw new Error(`Keep the task and context under ${maximumSubagentTaskCharacters} characters.`);
  return { agent, task, context };
}

// Several agents run commands in the same project at once.
export const sharedMachineRule = "Other agents may be running commands in this project at the same time. Never stop processes you did not start (no pkill or killall by name), and use your own temporary directories and free ports for servers and test runs.";

export function subagentSystemPrompt(profile, permissionMode) {
  return [
    `You are the "${profile.name}" subagent, working for a primary coding agent in the user's selected project.`,
    "Complete only the delegated task. You cannot ask questions; make reasonable assumptions and state them.",
    permissionMode === "read-only"
      ? "Permission mode: read-only. Inspect the project but do not try to modify it."
      : "Permission mode: workspace-write. Edit only the files the task requires; other agents may be editing other files at the same time. Prefer `unreal-apply-patch` with a standard unified diff for precise edits.",
    "Use Bash for inspection, tests, and commands. Inspect narrowly and keep command output concise.",
    sharedMachineRule,
    "Finish with a concise report for the primary agent: what you found or changed, exact file paths, evidence, and anything left unresolved.",
    ...(profile.instructions ? [profile.instructions] : [])
  ].join("\n");
}

export function subagentTaskPrompt({ task, context }) {
  return context ? `${task}\n\nContext from the primary agent:\n${context}` : task;
}

// Runner JSONL: the report is the visible text of the last response that had any.
export function subagentReport(stdout) {
  let report = "";
  const compactionTurns = new Set();
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.Kind === "turn" && event.Data?.Type === "compaction") compactionTurns.add(event.Data.ID);
    // A compaction summary is a handoff for the model, not the subagent's report.
    if (event?.Kind !== "model_response" || compactionTurns.has(event.Data?.TurnID)) continue;
    const text = (event.Data?.Response?.Output || [])
      .filter((item) => item?.Type === "message" && item.Data?.Phase !== "analysis" && item.Data?.Text)
      .map((item) => item.Data.Text).join("").trim();
    if (text) report = text;
  }
  return report;
}

export function boundedReport(value, maximum = maximumSubagentReportCharacters) {
  const report = String(value || "").trim();
  if (report.length <= maximum) return report;
  return `${report.slice(0, maximum).trimEnd()}\n[Report truncated at ${maximum} characters.]`;
}

export function claudeSubagentArgs({ sessionId, model, permissionMode, systemPrompt, prompt, resume = false }) {
  return ["-p", prompt, "--output-format", "json", "--model", model, resume ? "--resume" : "--session-id", sessionId,
    "--append-system-prompt", systemPrompt, "--permission-mode", "bypassPermissions",
    // The macOS sandbox is the write boundary; also withhold Claude's edit tools.
    ...(permissionMode === "read-only" ? ["--disallowedTools", "Edit", "Write", "NotebookEdit"] : [])];
}

const firstLine = (value, maximum) => {
  const line = String(value || "").trim().split("\n")[0].trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
};
const maximumSteps = 40;

// Live view of one delegation for the chat. It is sent as an ACP tool call
// (so it is recorded and replayed with the conversation) whose
// _meta["unreal-agent/subagent"] carries the structured state the Console draws.
export class SubagentMonitor {
  constructor({ runId, profile, delegation, provider, model, access, notify, now = Date.now, interval = 300 }) {
    this.notify = notify; this.now = now; this.interval = interval; this.timer = null; this.done = false;
    this.toolCallId = `subagent-${runId}`;
    this.state = { runId, agent: profile.id, name: profile.name, provider, model: model || "", access,
      task: delegation.task, status: "running", startedAt: now(), endedAt: null,
      steps: [], stepCount: 0, activity: "", inputTokens: 0, outputTokens: 0, cost: null };
  }

  meta() { return { "unreal-agent/subagent": { ...this.state, steps: this.state.steps.slice(-maximumSteps) } }; }

  start() {
    return this.notify({ sessionUpdate: "tool_call", toolCallId: this.toolCallId, kind: "other", status: "in_progress",
      title: `${this.state.name} · ${firstLine(this.state.task, 90)}`,
      rawInput: { agent: this.state.agent, task: this.state.task }, _meta: this.meta() });
  }

  // Updates are coalesced so a busy subagent cannot flood the chat.
  schedule() {
    if (this.done || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; if (!this.done) void this.send(); }, this.interval);
    this.timer.unref?.();
  }

  send(extra = {}) {
    return this.notify({ sessionUpdate: "tool_call_update", toolCallId: this.toolCallId,
      status: this.done ? (this.state.status === "completed" ? "completed" : "failed") : "in_progress", ...extra, _meta: this.meta() });
  }

  // `updates` are parseHarnessEvent results from the subagent's runner.
  observe(updates = []) {
    for (const update of updates) {
      if (update.kind === "tool_start") {
        this.state.stepCount += 1;
        this.state.steps.push({ id: update.id, title: firstLine(update.title, 140), status: "running" });
        if (this.state.steps.length > maximumSteps) this.state.steps.shift();
      } else if (update.kind === "tool_update") {
        const step = this.state.steps.find((item) => item.id === update.id);
        if (step) step.status = update.status === "completed" ? "completed" : update.status === "failed" ? "failed" : step.status;
      } else if (update.kind === "message" && update.role === "agent") {
        this.state.activity = firstLine(update.text, 200);
      }
    }
    if (updates.length) this.schedule();
  }

  usage(delta, cost) {
    if (!delta) return;
    this.state.inputTokens += delta.inputTokens || 0;
    this.state.outputTokens += delta.outputTokens || 0;
    if (Number.isFinite(cost) && cost >= 0) this.state.cost = (this.state.cost || 0) + cost;
    this.schedule();
  }

  // A swarm member that finished is woken again by a peer's message.
  resume() {
    if (!this.done) return;
    this.done = false;
    Object.assign(this.state, { status: "running", endedAt: null });
    delete this.state.error;
    this.schedule();
  }

  finish(status, { model, report, error } = {}) {
    if (this.done) return Promise.resolve();
    this.done = true;
    clearTimeout(this.timer); this.timer = null;
    Object.assign(this.state, { status, endedAt: this.now(), ...(model ? { model } : {}), ...(error ? { error: String(error).slice(0, 2000) } : {}) });
    for (const step of this.state.steps) if (step.status === "running") step.status = status === "completed" ? "completed" : "stopped";
    const text = report || error;
    return this.send(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {});
  }
}
