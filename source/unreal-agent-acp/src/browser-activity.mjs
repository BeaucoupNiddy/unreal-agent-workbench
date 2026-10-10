import { promises as fs } from "node:fs";
import path from "node:path";

// A per-chat record of browser steps for Agent Console's Browser panel. The
// bridge appends one JSON line per step and keeps the latest frame from each
// agent (main agent, subagents, swarm members) as a small JPEG beside it.
// Nothing here reaches the model.

const maximumLogBytes = 1024 * 1024;
const retainedEntries = 400;
export const browserImageName = /^(?:frame-[A-Za-z0-9_-]{1,80}\.jpg|screenshot-[A-Za-z0-9_.-]{1,120}\.png)$/;

export function safeBrowserId(value) {
  return String(value || "").replace(/[^\w.-]/g, "_");
}

export function browserActivityDirectory(dataDir, chatId) {
  return path.join(dataDir, "sessions", "browser", safeBrowserId(chatId));
}

// Subagents and swarm members record into their parent chat's folder.
export function browserActivityOwner(session) {
  const chatId = session.parentId || session.id;
  const agentKey = session.parentId ? safeBrowserId(`sub-${String(session.id).slice(-12)}`) : "main";
  const agent = session.agentLabel || (session.parentId ? "Subagent" : "Main agent");
  return { chatId, agentKey, agent };
}

function shortText(value, maximum = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

export function describeBrowserStep(action, args = {}) {
  const target = args.ref ? `ref ${args.ref}` : args.selector ? shortText(args.selector, 80)
    : args.label ? `“${shortText(args.label, 60)}”` : args.text ? `“${shortText(args.text, 60)}”` : "";
  switch (action) {
    case "open": return shortText(args.url, 200);
    case "type": return `${args.ref ? `ref ${args.ref}` : args.selector ? shortText(args.selector, 80) : args.label ? `“${shortText(args.label, 60)}”` : ""} ← ${String(args.text ?? "").length} characters${args.submit ? ", then Enter" : ""}`;
    case "press": return `${shortText(args.key, 40)}${target ? ` on ${target}` : ""}`;
    case "select": return `${target} → ${shortText(JSON.stringify(args.values ?? args.value ?? ""), 80)}`;
    case "wait": return args.text ? `for “${shortText(args.text, 60)}”${args.gone ? " to go" : ""}` : args.selector ? `for ${shortText(args.selector, 60)}` : `${Number(args.ms) || 1000} ms`;
    case "eval": return shortText(args.expression || args.script, 120);
    case "screenshot": return target || (args.fullPage || args.full_page ? "full page" : "viewport");
    case "viewport": return `${Number(args.width) || 1280}×${Number(args.height) || 800}`;
    case "tabs": return args.index === undefined ? "list" : `switch to ${args.index}`;
    case "scroll": return `${Number(args.y ?? 700) || 0} px`;
    case "console": case "network": return args.all ? "all" : "errors";
    default: return target;
  }
}

export async function appendBrowserActivity(directory, entry) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "activity.jsonl");
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  const stat = await fs.stat(file).catch(() => null);
  if (stat && stat.size > maximumLogBytes) {
    // Keep recent steps within half the limit so trimming stays occasional.
    const lines = [];
    let bytes = 0;
    for (const line of (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).reverse()) {
      bytes += Buffer.byteLength(line) + 1;
      if (lines.length >= retainedEntries || bytes > maximumLogBytes / 2) break;
      lines.unshift(line);
    }
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  }
}

// Entries carry a `seq` within the retained log, so a viewer can ask only for
// steps after the last one it showed. A trimmed log restarts the numbering,
// which `reset` reports.
export async function readBrowserActivity(directory, { after = 0, limit = 200 } = {}) {
  const text = await fs.readFile(path.join(directory, "activity.jsonl"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  const numbered = entries.map((entry, index) => ({ ...entry, seq: index + 1 }));
  const start = Number(after) || 0;
  const reset = start > numbered.length;
  const fresh = reset ? numbered : numbered.filter((entry) => entry.seq > start);
  const agents = new Map();
  for (const entry of numbered) {
    const previous = agents.get(entry.agentKey);
    agents.set(entry.agentKey, { key: entry.agentKey, label: entry.agent, url: entry.url || previous?.url || "", title: entry.title ?? previous?.title ?? "",
      frame: entry.frame || previous?.frame || "", at: entry.at });
  }
  return { total: numbered.length, reset, entries: fresh.slice(-limit), agents: [...agents.values()] };
}

export async function readBrowserImage(directory, name) {
  if (!browserImageName.test(String(name || ""))) return null;
  return fs.readFile(path.join(directory, name)).catch(() => null);
}
