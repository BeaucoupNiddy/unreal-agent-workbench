import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeModelSettings } from "./model-settings.mjs";

// Subagent profiles shared by the Console's Settings and the capability broker.
// The primary agent itself remains the new-chat default in default-model.json.
export const agentSettingsFileName = "agents.json";
export const subagentAccessLevels = ["read-only", "workspace-write"];
export const maximumSubagents = 12;
export const defaultSwarmSettings = Object.freeze({ enabled: false, use: "asked", size: 4, maxMessages: 60, maxWakes: 3 });
export const defaultAgentSettings = Object.freeze({ enabled: false, maxConcurrent: 3, delegation: 3, swarm: defaultSwarmSettings, subagents: [] });
export const swarmUses = ["asked", "hard"];

// How readily the primary agent hands work off, from 1 (only when asked) to 5
// (coordinate and delegate almost everything). The guidance is the whole effect.
export const delegationLevels = Object.freeze([
  { level: 1, name: "Only when asked",
    guidance: "Delegate only when the user explicitly asks you to use a subagent. Otherwise do the work yourself." },
  { level: 2, name: "Sparingly",
    guidance: "Delegate only large, clearly separable work, such as a search across many parts of the project or an independent review of a big change. Do everything else yourself, including anything that needs this conversation's context." },
  { level: 3, name: "Balanced",
    guidance: "Delegate when it saves meaningful work, such as broad searches, independent reviews, or separable edits. Do it yourself when the task is small or needs this conversation's context." },
  { level: 4, name: "Eagerly",
    guidance: "Prefer delegating. Hand off searches, reading more than a few files, research, test runs, reviews, and well-scoped edits. Keep planning, decisions, and the final answer for yourself, and do a task yourself only when it takes a command or two." },
  { level: 5, name: "Maximum savings",
    guidance: "Act as a coordinator to save your own tokens. Delegate nearly all investigation, research, testing, and editing; plan the work, brief subagents fully, check their reports, and write the final answer. Do a step yourself only when briefing a subagent would cost more than doing it." }
]);

function text(value, maximum, label, { required = false } = {}) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new Error(`Enter a ${label}.`);
  if (result.length > maximum) throw new Error(`Keep the ${label} under ${maximum} characters.`);
  return result;
}

export function subagentId(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function normalizeSubagent(value = {}) {
  const name = text(value.name, 60, "subagent name", { required: true });
  const id = subagentId(value.id || name);
  if (!id) throw new Error("Give the subagent a name with letters or numbers.");
  const description = text(value.description, 500, "\"use when\" description", { required: true });
  const model = normalizeModelSettings({ provider: value.provider, model: value.model, thoughtLevel: value.thoughtLevel || undefined });
  if (!model.provider) throw new Error(`Choose a provider for ${name}.`);
  const access = value.access === undefined ? "read-only" : value.access;
  if (!subagentAccessLevels.includes(access)) throw new Error("Choose Read only or Workspace access.");
  return {
    id, name, description, ...model, access,
    instructions: text(value.instructions, 4000, "extra instructions"),
    enabled: value.enabled !== false
  };
}

export function normalizeAgentSettings(value = {}) {
  const subagents = (Array.isArray(value?.subagents) ? value.subagents : []).map(normalizeSubagent);
  if (subagents.length > maximumSubagents) throw new Error(`Add up to ${maximumSubagents} subagents.`);
  const ids = new Set();
  for (const agent of subagents) {
    if (ids.has(agent.id)) throw new Error(`Two subagents are named "${agent.id}". Give each a different name.`);
    ids.add(agent.id);
  }
  const concurrent = Number(value?.maxConcurrent ?? defaultAgentSettings.maxConcurrent);
  const delegation = Number(value?.delegation ?? defaultAgentSettings.delegation);
  return {
    enabled: value?.enabled === true,
    maxConcurrent: Number.isInteger(concurrent) ? Math.min(8, Math.max(1, concurrent)) : defaultAgentSettings.maxConcurrent,
    delegation: Number.isInteger(delegation) ? Math.min(5, Math.max(1, delegation)) : defaultAgentSettings.delegation,
    swarm: normalizeSwarmSettings(value?.swarm),
    subagents
  };
}

const bounded = (value, minimum, maximum, fallback) => {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
};

// Swarms: several subagents on one problem that message each other while they
// work. Off unless the user turns it on; costs scale with size and messages.
export function normalizeSwarmSettings(value = {}) {
  return {
    enabled: value?.enabled === true,
    use: swarmUses.includes(value?.use) ? value.use : defaultSwarmSettings.use,
    size: bounded(value?.size, 2, 8, defaultSwarmSettings.size),
    maxMessages: bounded(value?.maxMessages, 10, 200, defaultSwarmSettings.maxMessages),
    maxWakes: bounded(value?.maxWakes, 0, 5, defaultSwarmSettings.maxWakes)
  };
}

export async function readAgentSettings(dataDir) {
  try { return normalizeAgentSettings(JSON.parse(await fs.readFile(path.join(dataDir, agentSettingsFileName), "utf8"))); }
  catch (error) {
    // A missing or damaged file must never break chats; delegation is simply off.
    if (error.code === "ENOENT" || error instanceof SyntaxError || !error.code) return normalizeAgentSettings({});
    throw error;
  }
}

export async function saveAgentSettings(dataDir, value) {
  const settings = normalizeAgentSettings(value);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, agentSettingsFileName);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  return settings;
}

export function activeSubagents(settings) {
  return settings?.enabled ? (settings.subagents || []).filter((agent) => agent.enabled) : [];
}

// A subagent never exceeds its chat, and is never unsandboxed: Full computer
// access chats still confine Workspace subagents to the workspace sandbox.
export function subagentPermission(parentMode, access) {
  if (parentMode === "read-only" || access !== "workspace-write") return "read-only";
  return "workspace-write";
}

export function subagentInstructions(settings) {
  const agents = activeSubagents(settings);
  if (!agents.length) return [];
  const roster = agents.map((agent) => `${agent.id} (${agent.access === "workspace-write" ? "can edit" : "read only"}): ${agent.description}`).join("; ");
  return [
    `Subagents are available: ${roster}.`,
    "Delegate a self-contained task with `unreal-capability delegate '{\"agent\":\"<id>\",\"task\":\"complete instructions and expected report\"}'`. The subagent cannot see this conversation, so include every needed path, decision, and constraint. Run independent delegations as separate commands in the same response so they run in parallel, at most " + settings.maxConcurrent + " at once.",
    `${delegationGuidance(settings.delegation)} Never give two editing subagents overlapping files. Verify important claims from a subagent's report before relying on them.`,
    "The user sees each subagent's live progress, so do not write a message as each one starts or finishes. Wait quietly until the reports you need are in, then write one complete final answer.",
    "While subagents are working, do not investigate the areas you handed off; that duplicates their work and cost. Only do clearly separate work (for example a baseline test run), or simply wait. Each command returns its report when it finishes; there is no status command, and you cannot message running subagents.",
    ...swarmInstructions(settings, agents)
  ];
}

export function swarmInstructions(settings, agents = activeSubagents(settings)) {
  const swarm = settings?.swarm;
  if (!swarm?.enabled || !agents.length) return [];
  return [
    `A swarm is also available: several subagents work on one problem at the same time and message each other to share findings, challenge claims, and converge. Start one with \`unreal-capability swarm '{"task":"the whole problem and the answer you need","agents":["<id>","<id>",...],"angles":["optional starting approach per member"]}'\`. List up to ${swarm.size} agents (repeat an id for several of the same kind; omit "agents" for ${swarm.size} members drawn from the roster). It returns every member's final report and a log of their discussion.`,
    swarm.use === "hard"
      ? "Use a swarm when the user asks for one, or for a hard problem that benefits from several independent attempts and debate, such as research with conflicting sources, a stubborn bug with several plausible causes, or a design decision. A swarm costs several times a single subagent, so never use one for routine work."
      : "Use a swarm only when the user explicitly asks for one. It costs several times a single subagent."
  ];
}

export function delegationGuidance(level) {
  return (delegationLevels.find((item) => item.level === level) || delegationLevels[2]).guidance;
}
