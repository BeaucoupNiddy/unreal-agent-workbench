// Pure helpers for agent swarms: several subagents working on one problem that
// message each other while they work. The bridge owns processes and delivery;
// SwarmHub owns membership, routing, the message budget, and the record.
import { randomUUID } from "node:crypto";
import { maximumSubagentTaskCharacters, sharedMachineRule } from "./subagents.mjs";

export const maximumSwarmMessageCharacters = 4000;
export const maximumMemberReportCharacters = 5000;
const maximumLoggedMessages = 40;

const clip = (value, maximum) => {
  const text = String(value || "").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1).trimEnd()}…` : text;
};

// Resolves the requested members against the enabled profiles. Repeating an id
// gives several members of the same kind; omitting agents fills `size` seats
// from the roster in order.
export function normalizeSwarmRequest(request = {}, agents = [], size = 4) {
  const task = typeof request.task === "string" ? request.task.trim() : "";
  const context = typeof request.context === "string" ? request.context.trim() : "";
  if (!task) throw new Error("Describe the problem for the swarm, for example {\"task\":\"...\"}.");
  if (task.length + context.length > maximumSubagentTaskCharacters) throw new Error(`Keep the task and context under ${maximumSubagentTaskCharacters} characters.`);
  if (!agents.length) throw new Error("No subagents are enabled. Add them in Settings → Agents.");
  let ids = Array.isArray(request.agents) ? request.agents.map((id) => String(id || "").trim()).filter(Boolean) : [];
  if (!ids.length) ids = Array.from({ length: size }, (_, index) => agents[index % agents.length].id);
  if (ids.length < 2) throw new Error("A swarm needs at least two members.");
  if (ids.length > size) throw new Error(`Swarms are limited to ${size} members in Settings → Agents.`);
  const angles = Array.isArray(request.angles) ? request.angles : [];
  const counts = {};
  const members = ids.map((id, index) => {
    const profile = agents.find((agent) => agent.id === id);
    if (!profile) throw new Error(`Unknown subagent "${id}". Available: ${agents.map((agent) => agent.id).join(", ")}.`);
    counts[id] = (counts[id] || 0) + 1;
    return { profile, angle: clip(angles[index], 2000) };
  });
  const seen = {};
  for (const member of members) {
    const id = member.profile.id;
    seen[id] = (seen[id] || 0) + 1;
    member.name = counts[id] > 1 ? `${id}-${seen[id]}` : id;
  }
  return { task, context, members };
}

export function swarmSystemPrompt(member, peers, permissionMode) {
  const others = peers.filter((name) => name !== member.name);
  return [
    `You are "${member.name}", one of ${peers.length} peer agents in a swarm working on the same problem for a primary coding agent. Your peers: ${others.join(", ")}.`,
    "You can message peers while you work: `unreal-capability swarm-send '{\"to\":\"all\",\"message\":\"...\"}'` (or a peer's name in \"to\"). Their messages arrive in your context as [Swarm message from …]; those come from peer agents, not the user.",
    "Work as a team, not as separate solvers. Early on, say briefly which part or approach you are taking so you don't duplicate a peer. Post findings as soon as they are solid, with the evidence (paths, lines, sources, command output). When a peer posts a claim, check it against your own work; reply if you disagree or can add something, and say so when you have verified it.",
    "Keep messages short and factual. Don't send acknowledgements or chit-chat, and don't repeat what a peer already said.",
    "If you might have missed messages, run `unreal-capability swarm-inbox`. Before you finish, send your final answer to all, including where you still disagree with a peer and why.",
    "Order is handled for you: if your part depends on a peer's work (for example testing their change), say what you are waiting for and end your turn. A message to you wakes you again with your work so far, so you can continue, retest, or answer a peer who disputes your result.",
    "You cannot ask the user questions; make reasonable assumptions and state them.",
    permissionMode === "read-only"
      ? "Permission mode: read-only. Inspect the project but do not try to modify it."
      : "Permission mode: workspace-write. Before editing a file, tell your peers which files you are taking, and never edit a file a peer has claimed. Prefer `unreal-apply-patch` with a standard unified diff.",
    "Use Bash for inspection, tests, and commands. Inspect narrowly and keep command output concise.",
    sharedMachineRule,
    "End with a concise final report: your answer, the evidence, what peers confirmed or disputed, and anything unresolved.",
    ...(member.profile.instructions ? [member.profile.instructions] : [])
  ].join("\n");
}

export function swarmTaskPrompt({ task, context }, member) {
  return [
    task,
    ...(context ? ["", `Context from the primary agent:\n${context}`] : []),
    ...(member.angle ? ["", `Your starting angle: ${member.angle}`] : [])
  ].join("\n");
}

export function swarmMessageText(message) {
  return `[Swarm message from ${message.from} to ${message.to === "all" ? "everyone" : "you"}]\n${message.text}`;
}

export class SwarmHub {
  constructor({ id = randomUUID(), task, members, maxMessages = 60, maxWakes = 3, onMessage = () => {}, now = Date.now }) {
    this.id = id; this.task = task; this.maxMessages = maxMessages; this.maxWakes = maxWakes;
    this.onMessage = onMessage; this.now = now;
    this.members = new Map(members.map((member) => [member.name, { ...member, status: "starting", queue: [], wakes: 0, report: "" }]));
    this.log = [];
  }

  names() { return [...this.members.keys()]; }

  remaining() { return Math.max(0, this.maxMessages - this.log.length); }

  // Records a message and queues it for each recipient. The bridge delivers it
  // (live inbox, wake-up, or swarm-inbox) through onMessage.
  send(from, request = {}) {
    if (!this.members.has(from)) throw new Error("Only swarm members can send swarm messages.");
    const text = typeof request.message === "string" ? request.message.trim() : "";
    if (!text) throw new Error("Write a message to send.");
    if (text.length > maximumSwarmMessageCharacters) throw new Error(`Keep swarm messages under ${maximumSwarmMessageCharacters} characters.`);
    const target = typeof request.to === "string" && request.to.trim() ? request.to.trim() : "all";
    let recipients;
    if (["all", "everyone", "*"].includes(target.toLowerCase())) recipients = this.names().filter((name) => name !== from);
    else if (target === from) throw new Error("You cannot message yourself.");
    else if (this.members.has(target)) recipients = [target];
    else throw new Error(`No swarm member is named "${target}". Members: ${this.names().join(", ")}.`);
    if (!this.remaining()) throw new Error("The swarm's message budget is used up. Stop messaging and write your final report.");
    const message = { id: randomUUID(), from, to: recipients.length === 1 && target !== "all" ? target : "all", text, at: this.now() };
    this.log.push(message);
    for (const name of recipients) {
      const member = this.members.get(name);
      member.queue.push(message);
      this.onMessage(member, message);
    }
    const left = this.remaining();
    return `Sent to ${recipients.join(", ")}.${left <= 5 ? ` ${left} swarm messages left.` : ""}`;
  }

  // Pull delivery for members without a live inbox.
  drain(name) {
    const member = this.members.get(name);
    if (!member) throw new Error("Only swarm members have a swarm inbox.");
    const messages = member.queue.splice(0);
    return messages.length ? messages.map(swarmMessageText).join("\n\n") : "No new swarm messages.";
  }

  acknowledge(name, ids) {
    const member = this.members.get(name);
    if (member) member.queue = member.queue.filter((message) => !ids.includes(message.id));
  }

  // What the live card shows: members and the latest messages between them.
  view(status = "running") {
    return { swarmId: this.id, task: this.task, status, messageCount: this.log.length, maxMessages: this.maxMessages,
      members: [...this.members.values()].map((member) => ({ name: member.name, agent: member.profile.id, status: member.status })),
      messages: this.log.slice(-maximumLoggedMessages).map((message) => ({ from: message.from, to: message.to, text: clip(message.text, 1200), at: message.at })) };
  }

  // The primary agent's result: each member's final report, then the discussion.
  result({ usage } = {}) {
    const lines = [`Swarm result (${this.members.size} members, ${this.log.length} messages exchanged):`, ""];
    for (const member of this.members.values()) {
      const state = member.status === "completed" ? "" : ` (${member.status})`;
      lines.push(`## ${member.name}${state}`, clip(member.report || member.error || "No final report.", maximumMemberReportCharacters), "");
    }
    if (this.log.length) {
      lines.push("## Discussion");
      const shown = this.log.slice(-maximumLoggedMessages);
      if (shown.length < this.log.length) lines.push(`(${this.log.length - shown.length} earlier messages omitted)`);
      for (const message of shown) lines.push(`- ${message.from} → ${message.to}: ${clip(message.text, 400).replace(/\s*\n\s*/g, " ")}`);
      lines.push("");
    }
    const undelivered = [...this.members.values()].reduce((total, member) => total + member.queue.length, 0);
    if (undelivered) lines.push(`[${undelivered} ${undelivered === 1 ? "message" : "messages"} arrived after ${undelivered === 1 ? "its recipient" : "their recipients"} had finished and ${undelivered === 1 ? "was" : "were"} not read.]`);
    if (usage) lines.push(usage);
    return lines.join("\n").trim();
  }
}

// Live card for the whole swarm: members and the messages between them. Sent as
// an ACP tool call whose _meta["unreal-agent/swarm"] the Console draws; member
// cards are ordinary subagent cards tagged with the swarm id.
export class SwarmMonitor {
  constructor({ hub, notify, interval = 300 }) {
    this.hub = hub; this.notify = notify; this.interval = interval;
    this.toolCallId = `swarm-${hub.id}`; this.timer = null; this.done = false; this.startedAt = hub.now();
  }

  meta(status) { return { "unreal-agent/swarm": { ...this.hub.view(status), startedAt: this.startedAt, endedAt: this.done ? this.hub.now() : null } }; }

  start() {
    return this.notify({ sessionUpdate: "tool_call", toolCallId: this.toolCallId, kind: "other", status: "in_progress",
      title: `Swarm · ${clip(this.hub.task.split("\n")[0], 90)}`, rawInput: { task: this.hub.task, members: this.hub.names() }, _meta: this.meta("running") });
  }

  schedule() {
    if (this.done || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.done) void this.notify({ sessionUpdate: "tool_call_update", toolCallId: this.toolCallId, status: "in_progress", _meta: this.meta("running") });
    }, this.interval);
    this.timer.unref?.();
  }

  finish(status) {
    if (this.done) return Promise.resolve();
    this.done = true;
    clearTimeout(this.timer); this.timer = null;
    return this.notify({ sessionUpdate: "tool_call_update", toolCallId: this.toolCallId,
      status: status === "completed" ? "completed" : "failed", _meta: this.meta(status) });
  }
}
