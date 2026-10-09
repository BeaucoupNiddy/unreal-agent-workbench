// Settings → Agents: subagent profiles. The primary agent's selects live in the
// same form (defaultProvider/defaultModel) and are handled by app.js.
export const reasoningLevels = [
  { value: "", name: "Provider default" }, { value: "low", name: "Low" }, { value: "medium", name: "Medium" },
  { value: "high", name: "High" }, { value: "xhigh", name: "Extra high" }, { value: "max", name: "Max" }
];
// Settings copy for the delegation slider; the prompt text lives in agent-profiles.mjs.
export const delegationChoices = [
  { level: 1, name: "Only when asked", description: "The primary agent does everything itself unless you ask it to use a subagent." },
  { level: 2, name: "Sparingly", description: "Only large, clearly separate jobs, like project-wide searches or reviewing a big change." },
  { level: 3, name: "Balanced", description: "Delegates when it saves real work: broad searches, independent reviews, separate edits." },
  { level: 4, name: "Eagerly", description: "Hands off most searching, reading, research, tests and scoped edits. Keeps planning and the final answer." },
  { level: 5, name: "Maximum savings", description: "The primary agent mostly plans, briefs subagents and checks their work. Uses the fewest primary-model tokens." }
];
export const accessLevels = [
  { value: "read-only", name: "Read only" },
  { value: "workspace-write", name: "Can edit files" }
];

// Built-in subagents. Provider and model come from inheritModel, so a preset
// runs on whatever the user already set up.
export function subagentPresets() {
  return [
    { name: "Explorer", thoughtLevel: "low", access: "read-only",
      description: "Finding where something is defined, used, or configured across the project, or mapping how a feature works. Returns file paths with a one-line note each.",
      instructions: "Search broadly first (rg, file listings), then read only the relevant excerpts. Don't paste whole files. Give paths with line numbers, and say what you did not check." },
    { name: "Researcher", thoughtLevel: "medium", access: "read-only",
      description: "Looking up outside information: library or engine documentation, API behavior, version differences, or an unfamiliar error message. Returns a short answer with source links.",
      instructions: "Prefer official documentation and release notes. Note which version each source covers. Keep what the sources say separate from your own inference." },
    { name: "Reviewer", thoughtLevel: "high", access: "read-only",
      description: "An independent review of a diff, plan, or design before it is finalized. Returns concrete problems ranked by severity.",
      instructions: "Look for bugs, missed edge cases, and broken callers before style. For each problem give the file and line, why it is wrong, and a suggested fix. Say plainly if you found nothing serious." },
    { name: "Tester", thoughtLevel: "medium", access: "workspace-write",
      description: "Writing and running tests for a change that is already made, or reproducing a reported bug. Returns what passed, what failed, and the likely cause.",
      instructions: "Follow the project's existing test framework and conventions. Add or change test files only; don't change the code under test. Include the exact commands you ran and the relevant failure output." },
    { name: "Worker", thoughtLevel: "medium", access: "workspace-write",
      description: "Well-scoped edits to files no other agent is touching, such as a separate module, a migration, or a batch of similar changes.",
      instructions: "Change only the files the task names or clearly requires. Run the closest tests or a build check before reporting, and list every file you changed." }
  ].map((agent) => ({ provider: "", model: "", enabled: true, ...agent }));
}

// New subagents copy the provider and model of the last subagent in the list,
// or the primary agent's when the list is empty.
export function inheritModel(agent, existing = [], primary = {}) {
  const source = existing.at(-1) || primary;
  return { ...agent, provider: source.provider || "", model: source.model || "" };
}

// Choices for the "Add subagent" menu: a blank profile plus the presets not
// already in the list (names must be unique).
export function addChoices(existing = []) {
  const taken = new Set(existing.map((agent) => String(agent.name || "").trim().toLowerCase()));
  return [{ value: "blank", name: "Blank subagent" },
    ...subagentPresets().map((preset) => ({ value: preset.name, name: preset.name, disabled: taken.has(preset.name.toLowerCase()) }))];
}

export function modelChoices(providers = [], providerId = "", saved = "") {
  const provider = providers.find((item) => item.id === providerId);
  const choices = [...(provider?.models || [])].map((model) => ({ value: model.value, name: model.name || model.value }));
  if (saved && !choices.some((model) => model.value === saved)) choices.unshift({ value: saved, name: `${saved} (unavailable)` });
  return [{ value: "", name: provider?.local ? "First available local model" : "Provider default" }, ...choices];
}

function option(value, name) {
  const element = document.createElement("option"); element.value = value; element.textContent = name; return element;
}

function field(label, control, className = "") {
  const wrapper = document.createElement("label");
  if (className) wrapper.className = className;
  wrapper.append(label, control);
  return wrapper;
}

function select(role, options, value) {
  const element = document.createElement("select");
  element.dataset.agentField = role;
  element.append(...options.map((item) => option(item.value, item.name)));
  element.value = value ?? "";
  return element;
}

function renderCard(agent, providers, onRemove) {
  const card = document.createElement("fieldset");
  card.className = "subagent-card";
  const heading = document.createElement("div");
  heading.className = "subagent-card-heading";
  const name = document.createElement("input");
  name.dataset.agentField = "name"; name.value = agent.name || ""; name.placeholder = "Subagent name"; name.maxLength = 60;
  name.setAttribute("aria-label", "Subagent name");
  const enabled = document.createElement("input");
  enabled.type = "checkbox"; enabled.dataset.agentField = "enabled"; enabled.checked = agent.enabled !== false;
  const remove = document.createElement("button");
  remove.type = "button"; remove.className = "subagent-remove"; remove.textContent = "Remove";
  remove.addEventListener("click", () => { card.remove(); onRemove(); });
  heading.append(name, field("On", enabled, "subagent-enabled"), remove);

  const description = document.createElement("textarea");
  description.dataset.agentField = "description"; description.rows = 2; description.maxLength = 500;
  description.value = agent.description || ""; description.placeholder = "When should the primary agent use this subagent?";

  const provider = select("provider", providers.map((item) => ({ value: item.id, name: item.name })), agent.provider);
  if (agent.provider && provider.value !== agent.provider) {
    provider.prepend(option(agent.provider, `${agent.provider} (unavailable)`)); provider.value = agent.provider;
  }
  const model = select("model", modelChoices(providers, provider.value, agent.model), agent.model);
  provider.addEventListener("change", () => model.replaceChildren(...modelChoices(providers, provider.value).map((item) => option(item.value, item.name))));
  const effort = select("thoughtLevel", reasoningLevels, agent.thoughtLevel);
  const access = select("access", accessLevels, agent.access || "read-only");

  const controls = document.createElement("div");
  controls.className = "subagent-controls";
  controls.append(field("Provider", provider), field("Model", model), field("Reasoning", effort), field("Access", access));

  const instructions = document.createElement("textarea");
  instructions.dataset.agentField = "instructions"; instructions.rows = 2; instructions.maxLength = 4000;
  instructions.value = agent.instructions || ""; instructions.placeholder = "Optional extra instructions for this subagent";
  const details = document.createElement("details");
  const summary = document.createElement("summary"); summary.textContent = "Extra instructions";
  details.append(summary, instructions);
  details.open = Boolean(agent.instructions);

  card.append(heading, field("Use when", description, "subagent-description"), controls, details);
  return card;
}

export function renderSubagents(container, agents = [], providers = [], onChange = () => {}) {
  container.replaceChildren(...agents.map((agent) => renderCard(agent, providers, onChange)));
  onChange();
}

export function appendSubagent(container, agent, providers = [], onChange = () => {}) {
  const card = renderCard(agent, providers, onChange);
  container.append(card);
  onChange();
  return card;
}

export function collectSubagents(container) {
  return [...container.querySelectorAll(".subagent-card")].map((card) => {
    const value = (role) => card.querySelector(`[data-agent-field="${role}"]`);
    return {
      name: value("name").value, description: value("description").value,
      provider: value("provider").value, model: value("model").value,
      ...(value("thoughtLevel").value ? { thoughtLevel: value("thoughtLevel").value } : {}),
      access: value("access").value, instructions: value("instructions").value,
      enabled: value("enabled").checked
    };
  });
}

// "Same model for all": sets every subagent card's provider and model.
export function applyModelToCards(container, provider, model) {
  for (const card of container.querySelectorAll(".subagent-card")) {
    const providerSelect = card.querySelector('[data-agent-field="provider"]');
    if (![...providerSelect.options].some((item) => item.value === provider)) providerSelect.prepend(option(provider, `${provider} (unavailable)`));
    providerSelect.value = provider;
    providerSelect.dispatchEvent(new Event("change"));
    const modelSelect = card.querySelector('[data-agent-field="model"]');
    if (model && ![...modelSelect.options].some((item) => item.value === model)) modelSelect.append(option(model, `${model} (unavailable)`));
    modelSelect.value = model || "";
  }
}
