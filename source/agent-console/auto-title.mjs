import { promises as fs } from "node:fs";
import path from "node:path";

// Hydra supplies a provisional title copied (and sometimes truncated) from
// the first prompt. Recognize it on reattach after a console restart.
export function isProvisionalTitle(title, history) {
  if (typeof title !== "string" || !title.trim()) return false;
  for (const line of String(history || "").split("\n")) {
    let update;
    try { update = JSON.parse(line)?.params?.update; } catch { continue; }
    if (update?.sessionUpdate !== "prompt_received") continue;
    const prompt = (update.prompt || []).filter((item) => item?.type === "text").map((item) => item.text).join("").trim();
    return Boolean(prompt) && (title.trim() === prompt ||
      (title.endsWith("…") && prompt.startsWith(title.slice(0, -1))));
  }
  return false;
}

export function hasCompletedTurn(history) {
  for (const line of String(history || "").trim().split("\n").reverse()) {
    let kind;
    try { kind = JSON.parse(line)?.params?.update?.sessionUpdate; } catch { continue; }
    if (kind === "turn_complete") return true;
    if (kind === "prompt_received") return false;
  }
  return false;
}

export async function recoverProvisionalTitle(sessionRoot, sessionId, scheduler, onCompleted) {
  const directory = path.join(sessionRoot, sessionId);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(directory, "meta.json"), "utf8"));
    if (meta.agentId !== "unreal" || meta.originatingClient?.name !== "unreal-agent-console") return false;
    const history = await fs.readFile(path.join(directory, "history.jsonl"), "utf8");
    if (!isProvisionalTitle(meta.title, history)) return false;
    // An existing in-process draft is already queued by its prompt handler.
    const newlyRecovered = !scheduler.pending.has(sessionId);
    scheduler.track(sessionId);
    if (newlyRecovered && hasCompletedTurn(history)) onCompleted?.();
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export class AutoTitleScheduler {
  constructor(regenerate) {
    this.regenerate = regenerate;
    this.pending = new Set();
  }

  track(sessionId) {
    if (sessionId) this.pending.add(sessionId);
  }

  async afterPrompt(sessionId) {
    if (!this.pending.delete(sessionId)) return false;
    try {
      await this.regenerate(sessionId);
      return true;
    } catch (error) {
      // A transient backend failure should not permanently strand the chat
      // with its raw first prompt as the title. Retry after its next turn.
      this.pending.add(sessionId);
      throw error;
    }
  }
}
