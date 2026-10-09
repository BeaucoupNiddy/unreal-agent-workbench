// Timings must originate from live events. Persisted turns can be restored, but
// replayed transcript entries have no reliable timestamps for new bars.
export function startProgress(now = Date.now()) {
  return { startedAt: now, endedAt: null, outcome: null, responseAt: null, steps: [], nextStep: 0, tools: new Map() };
}

export function finishProgress(progress, outcome = "completed", now = Date.now()) {
  if (progress && progress.endedAt === null) {
    progress.endedAt = Math.max(now, progress.startedAt);
    progress.outcome = outcome;
    // A task ending does not prove that every tool finished successfully.
    for (const tool of progress.tools.values()) {
      if (tool.endedAt === null) { tool.endedAt = progress.endedAt; tool.status = "interrupted"; }
    }
  }
}

// A thought chunk is a provider-supplied summary, never generated from tool titles.
// Only stream chunks with the same message ID belong to one summary. Distinct
// summaries stay separate even if no tool was called between them.
export function recordThought(progress, update, now = Date.now()) {
  const text = typeof update.content === "string" ? update.content : update.content?.text;
  if (!progress || progress.endedAt !== null || typeof text !== "string" || !text.trim()) return;
  const id = typeof update.messageId === "string" ? update.messageId : null;
  const last = progress.steps.at(-1);
  if (id && last?.id === id && !last.hasTools) {
    last.text = (last.text + text).slice(0, 2000);
  } else progress.steps.push({ id, text: text.slice(0, 2000), at: now, key: `step-${progress.nextStep++}`, hasTools: false });
  // Limit retained summaries per turn; older tools remain ungrouped rather than
  // being falsely attributed to a later summary.
  if (progress.steps.length > 80) progress.steps.shift();
}

export function recordTool(progress, update, now = Date.now()) {
  if (!progress || progress.endedAt !== null || !update.toolCallId) return;
  let tool = progress.tools.get(update.toolCallId);
  if (!tool) {
    // Earlier assistant text is not the final reply if a later tool starts.
    progress.responseAt = null;
    const step = progress.steps.at(-1);
    if (step) step.hasTools = true;
    tool = { id: update.toolCallId, title: update.title || "Tool activity", startedAt: now, endedAt: null, status: "pending", stepKey: step?.key ?? null };
    progress.tools.set(update.toolCallId, tool);
  }
  if (update.title) tool.title = update.title;
  if (tool.endedAt !== null) return; // A duplicate/stale update cannot reopen a returned tool.
  if (update.status) tool.status = update.status;
  if (tool.status !== "pending" && tool.status !== "in_progress") tool.endedAt = Math.max(now, tool.startedAt);
}

export function recordResponse(progress, now = Date.now()) {
  if (progress && progress.endedAt === null) progress.responseAt = Math.max(now, progress.startedAt);
}

export function progressSnapshot(progress, now = Date.now()) {
  const end = progress.endedAt ?? now;
  const elapsed = Math.max(1, end - progress.startedAt);
  const tools = [...progress.tools.values()].map((tool) => ({
    id: tool.id,
    title: tool.title,
    startedAt: tool.startedAt, endedAt: tool.endedAt,
    status: tool.endedAt === null ? "running" : tool.status, stepKey: tool.stepKey ?? null,
    // Offsets are relative to the actual elapsed time, not an estimated completion percentage.
    left: Math.max(0, Math.min(100, (tool.startedAt - progress.startedAt) / elapsed * 100)),
    width: Math.max(0, Math.min(100, ((tool.endedAt ?? end) - tool.startedAt) / elapsed * 100))
  }));
  return { elapsed, startedAt: progress.startedAt, endedAt: progress.endedAt, responseAt: progress.responseAt, steps: progress.steps,
    tools, running: tools.filter((tool) => tool.status === "running").length, outcome: progress.outcome };
}

export function hydrateProgress(saved) {
  if (!saved || !Number.isFinite(saved.startedAt) || !Array.isArray(saved.tools)) return null;
  const progress = startProgress(saved.startedAt);
  if (Array.isArray(saved.steps)) progress.steps = saved.steps.filter((step) =>
    step && Number.isFinite(step.at) && typeof step.text === "string" && step.text.trim()
  ).slice(-80).map((step) => ({ id: step.id || null, text: step.text.slice(0, 2000), at: step.at, key: typeof step.key === "string" ? step.key : `step-${progress.nextStep++}`, hasTools: true }));
  progress.nextStep = Number.isSafeInteger(saved.nextStep) ? Math.max(saved.nextStep, progress.steps.length) : progress.steps.length;
  for (const tool of saved.tools) {
    if (typeof tool?.id !== "string" || !Number.isFinite(tool.startedAt)) continue;
    progress.tools.set(tool.id, {
      id: tool.id, title: tool.title || "Tool activity", status: tool.status || "pending",
      startedAt: tool.startedAt, endedAt: Number.isFinite(tool.endedAt) ? tool.endedAt : null,
      stepKey: typeof tool.stepKey === "string" ? tool.stepKey : null
    });
  }
  if (Number.isFinite(saved.responseAt)) progress.responseAt = saved.responseAt;
  if (Number.isFinite(saved.endedAt)) finishProgress(progress, saved.outcome || "completed", saved.endedAt);
  return progress;
}

// Keep original tool order (including overlapping calls), placing each tool under
// the reasoning summary that was current when it started. Never infer a summary.
export function progressGroups(snapshot) {
  const groups = [];
  const byKey = new Map();
  const ungrouped = { step: null, tools: [] };
  for (const step of snapshot.steps || []) {
    const group = { step, tools: [] };
    groups.push(group);
    byKey.set(step.key, group);
  }
  for (const tool of snapshot.tools) (byKey.get(tool.stepKey) || ungrouped).tools.push(tool);
  if (ungrouped.tools.length) groups.unshift(ungrouped);
  return groups;
}
