import { promises as fs } from "node:fs";
import path from "node:path";
import { startProgress, finishProgress, recordTool, recordResponse, recordThought } from "./public/live-progress.js";

const MAX_TURNS = 20;
const MAX_TOOLS = 80;

export function serializeTurn(turn) {
  return {
    startedAt: turn.startedAt, endedAt: turn.endedAt, outcome: turn.outcome, responseAt: turn.responseAt, nextStep: turn.nextStep,
    steps: turn.steps.slice(-80).map(({ id, text, at, key }) => ({ id, text, at, key })),
    tools: [...turn.tools.values()].slice(-MAX_TOOLS).map(({ id, title, status, startedAt, endedAt, stepKey }) => ({ id, title, status, startedAt, endedAt, stepKey }))
  };
}

export function restoreTurn(value) {
  if (!value || !Number.isFinite(value.startedAt) || value.startedAt < 0 || !Array.isArray(value.tools)) return null;
  const turn = startProgress(value.startedAt);
  if (Array.isArray(value.steps)) turn.steps = value.steps.slice(-80).filter((step) =>
    step && Number.isFinite(step.at) && step.at >= turn.startedAt && typeof step.text === "string" && step.text.trim()
  ).map((step) => ({ id: typeof step.id === "string" ? step.id : null, text: step.text.slice(0, 2000), at: step.at, key: typeof step.key === "string" ? step.key : `step-${turn.nextStep++}`, hasTools: true }));
  turn.nextStep = Number.isSafeInteger(value.nextStep) ? Math.max(value.nextStep, turn.steps.length) : turn.steps.length;
  for (const tool of value.tools.slice(-MAX_TOOLS)) {
    if (!tool || typeof tool.id !== "string" || !Number.isFinite(tool.startedAt)) continue;
    turn.tools.set(tool.id, {
      id: tool.id, title: String(tool.title || "Tool activity").slice(0, 200),
      status: String(tool.status || "pending"), startedAt: tool.startedAt,
      endedAt: Number.isFinite(tool.endedAt) ? tool.endedAt : null,
      stepKey: typeof tool.stepKey === "string" ? tool.stepKey : null
    });
  }
  if (Number.isFinite(value.responseAt) && value.responseAt >= turn.startedAt &&
      (!Number.isFinite(value.endedAt) || value.responseAt <= value.endedAt)) turn.responseAt = value.responseAt;
  if (Number.isFinite(value.endedAt)) finishProgress(turn, value.outcome || "completed", value.endedAt);
  return turn;
}

// Only live notifications have trustworthy timing; never synthesize bars from history replay.
export class TurnHistory {
  constructor(file) {
    this.file = file;
    this.turns = [];
    this.pending = Promise.resolve();
  }

  async load() {
    const saved = await fs.readFile(this.file, "utf8").then(JSON.parse).catch((error) => {
      if (error.code !== "ENOENT") console.warn(`Cannot read turn timeline: ${error.message}`);
      return [];
    });
    this.turns = (Array.isArray(saved) ? saved : []).slice(-MAX_TURNS).map(restoreTurn).filter(Boolean);
    // If the Console was restarted while a request was active, it cannot know
    // its final result. Stop the clock at the last observed event, not at reload.
    for (const turn of this.turns) {
      if (turn.endedAt === null) {
        const lastSeen = Math.max(turn.startedAt, turn.responseAt || 0, ...turn.steps.map((step) => step.at), ...[...turn.tools.values()].flatMap((tool) => [tool.startedAt, tool.endedAt || 0]));
        finishProgress(turn, "interrupted", lastSeen);
      }
    }
    return this.snapshot();
  }

  snapshot() { return this.turns.map(serializeTurn); }

  start(now = Date.now()) {
    const turn = startProgress(now);
    this.turns.push(turn);
    this.turns = this.turns.slice(-MAX_TURNS);
    this.save();
    return turn;
  }

  tool(update, now = Date.now()) {
    recordTool(this.turns.at(-1), update, now);
    if (this.turns.at(-1)?.endedAt === null && update.toolCallId) this.save();
  }

  thought(update, now = Date.now()) {
    const turn = this.turns.at(-1);
    if (turn?.endedAt === null) { recordThought(turn, update, now); this.save(); }
  }

  response(now = Date.now()) {
    const turn = this.turns.at(-1);
    if (turn?.endedAt === null) { recordResponse(turn, now); this.save(); }
  }

  finish(outcome = "completed", now = Date.now()) {
    const turn = this.turns.at(-1);
    if (turn?.endedAt === null) { finishProgress(turn, outcome, now); this.save(); }
  }

  save() {
    const data = `${JSON.stringify(this.snapshot())}\n`;
    this.pending = this.pending.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, data, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    this.pending.catch((error) => console.warn(`Cannot save turn timeline: ${error.message}`));
    return this.pending;
  }
}
