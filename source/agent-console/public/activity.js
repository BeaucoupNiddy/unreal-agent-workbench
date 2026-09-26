function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function editFileCount(tool) {
  const match = String(tool.title || "").match(/^(\d+) files? changed$/i);
  return match ? Number(match[1]) : 1;
}

function activityKind(tool) {
  const title = String(tool.title || "");
  const command = typeof tool.input === "string" ? tool.input : tool.input?.command || "";
  const text = `${title}\n${command}`;
  if (tool.kind === "edit" || /(?:^|[\s/])(apply_patch|unreal-apply-patch)(?:\s|$)/i.test(text)) return "edit";
  if (tool.kind === "read" || /^(?:pwd|ls|find|rg|grep|sed|cat|head|tail|git (?:status|diff|show|log))\b/i.test(command.trim())) return "inspect";
  if (tool.kind === "execute") return "command";
  return "tool";
}

export function activitySummary(entries) {
  const tools = entries.filter((entry) => entry.type === "tool");
  if (!tools.length) return "Thought through the next step";

  const counts = { edit: 0, inspect: 0, command: 0, tool: 0 };
  for (const tool of tools) {
    const kind = activityKind(tool);
    counts[kind] += kind === "edit" ? editFileCount(tool) : 1;
  }

  const parts = [];
  if (counts.edit) parts.push(`Edited ${plural(counts.edit, "file")}`);
  if (counts.inspect) parts.push(`Inspected ${plural(counts.inspect, "item")}`);
  if (counts.command) parts.push(`Ran ${plural(counts.command, "command")}`);
  if (counts.tool) parts.push(`Used ${plural(counts.tool, "tool")}`);
  return parts.join(", ");
}

export function groupTranscriptEntries(entries, showThoughts = true) {
  const result = [];
  let activity = null;
  const flush = () => {
    if (activity?.entries.length) result.push(activity);
    activity = null;
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === "thought" || entry.type === "tool") {
      if (entry.type === "thought" && !showThoughts) continue;
      if (!activity) activity = { type: "activity", id: `activity-${entry.id || index}`, entries: [] };
      activity.entries.push(entry);
      continue;
    }
    flush();
    result.push(entry);
  }
  flush();
  return result;
}
