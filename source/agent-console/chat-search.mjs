import { promises as fs } from "node:fs";
import path from "node:path";

function textFrom(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).join("");
  if (!value || typeof value !== "object") return "";
  return typeof value.text === "string" ? value.text : textFrom(value.content);
}

export function searchableMessages(history) {
  const messages = [];
  const agents = new Map();
  for (const line of history.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const update = event?.params?.update;
    if (update?.sessionUpdate === "prompt_received") {
      const text = textFrom(update.prompt).trim();
      if (text) messages.push({ role: "You", text });
    } else if (update?.sessionUpdate === "agent_message_chunk") {
      const text = textFrom(update.content);
      if (!text) continue;
      const id = update.messageId || `last-${messages.length}`;
      let message = agents.get(id);
      if (!message) { message = { role: "Assistant", text: "" }; agents.set(id, message); messages.push(message); }
      message.text += text;
    }
  }
  return messages;
}

async function readHistory(file) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    if (size > length) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally { await handle.close(); }
}

function excerpt(text, term) {
  const plain = text.replace(/\s+/g, " ").trim();
  const start = Math.max(0, plain.toLocaleLowerCase().indexOf(term) - 65);
  const end = Math.min(plain.length, start + 190);
  return `${start ? "…" : ""}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
}

export async function searchChats({ sessions, sessionRoot, query }) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [];
  const eligible = sessions.filter((item) => item.agentId === "unreal" && /^hydra_session_[A-Za-z0-9_-]+$/.test(item.sessionId || ""));
  const results = [];
  // Search only Hydra-listed sessions; never use a client-provided path or ID.
  for (let offset = 0; offset < eligible.length; offset += 8) {
    const batch = await Promise.all(eligible.slice(offset, offset + 8).map(async (item) => {
      const title = String(item.title || "New chat");
      let messages = [];
      try { messages = searchableMessages(await readHistory(path.join(sessionRoot, item.sessionId, "history.jsonl"))); }
      catch (error) { if (error.code !== "ENOENT") console.warn(`Chat search skipped ${item.sessionId}: ${error.message}`); }
      const titleMatch = terms.every((term) => title.toLocaleLowerCase().includes(term));
      const message = messages.filter((entry) => terms.every((term) => entry.text.toLocaleLowerCase().includes(term))).at(-1);
      if (!titleMatch && !message) return null;
      return { sessionId: item.sessionId, title, cwd: item.cwd, updatedAt: item.updatedAt,
        role: message?.role || null, snippet: message ? excerpt(message.text, terms[0]) : "", titleMatch };
    }));
    results.push(...batch.filter(Boolean));
  }
  return results.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) ||
    (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, 50);
}
