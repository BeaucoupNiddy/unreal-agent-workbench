// Keep the header and in-conversation status in sync with existing events.
// Do not show raw commands or reasoning in the compact status label.
const activeTool = (tool) => tool.status === "pending" || tool.status === "in_progress";

function toolAction(tool) {
  const command = typeof tool.input === "string" ? tool.input : tool.input?.command || "";
  const title = String(tool.title || "");
  if (tool.kind === "edit" || /\b(?:apply_patch|unreal-apply-patch)\b/i.test(command)) return "Editing files";
  if (/\b(?:test|vitest|jest|pytest|cargo test|go test)\b/i.test(command)) return "Running tests";
  if (/\b(?:build|compile|tsc)\b/i.test(command)) return "Building project";
  if (tool.kind === "read" || /^(?:pwd|ls|find|rg|grep|sed|cat|head|tail|git (?:status|diff|show|log))\b/i.test(command.trim())) return "Inspecting project";
  if (/\b(?:search|browse|fetch)\b/i.test(title)) return "Searching for information";
  return "Running a tool";
}

export function taskStatus({ chat = false, project = false, ready = false, connection = "", running = false, submitting = false, stopping = false, error = "", entries = [] } = {}) {
  if (!ready) {
    if (connection === "Opening chat…") return { kind: "connecting", label: "Opening chat…" };
    if (connection === "Reconnecting") return { kind: "connecting", label: "Reconnecting…", detail: "Waiting for the chat connection to return" };
    if (connection === "Task unavailable") return { kind: "error", label: "Chat unavailable", detail: "The chat could not connect" };
    return { kind: "error", label: "Hydra unavailable", detail: "Check the local agent service" };
  }
  if (!chat) return { kind: "idle", label: project ? "Ready to start" : "Hydra connected" };
  if (error) return { kind: "error", label: "Task failed", detail: error };
  if (stopping) return { kind: "working", label: "Stopping task…" };
  // An outstanding approval can exist even if a prompt has not yet been
  // replayed after reconnecting. Never present it as ordinary work.
  if (entries.some((entry) => entry.type === "permission")) return { kind: "approval", label: "Approval needed", detail: "Review the request above the message box to continue" };
  if (submitting && !running) return { kind: "working", label: "Sending message…" };
  if (!running) return { kind: "idle", label: "Ready for a message" };

  const latestUser = entries.findLastIndex((entry) => entry.type === "message" && entry.role === "user");
  const turn = entries.slice(latestUser + 1);
  const tools = turn.filter((entry) => entry.type === "tool" && activeTool(entry));
  if (tools.length) {
    const label = toolAction(tools.at(-1));
    return { kind: "working", label, detail: tools.length > 1 ? `${tools.length} tools active` : "Tool in progress" };
  }
  const latest = turn.at(-1);
  if (latest?.type === "message" && latest.role === "agent") return { kind: "working", label: "Writing a response…" };
  if (latest?.type === "thought") return { kind: "working", label: "Thinking through the request…" };
  return { kind: "working", label: "Working on your request…" };
}
