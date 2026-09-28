import { isLocalProvider } from "./local-providers.mjs";

export const modelProviders = [
  { id: "openai-codex", name: "OpenAI Codex", description: "Models available through your Codex connection", defaultModel: "gpt-6-astra" },
  { id: "claude-code", name: "Claude Code", description: "Uses your Claude Code installation and Claude account sign-in", defaultModel: "sonnet" },
  { id: "openrouter", name: "OpenRouter", description: "Models from OpenAI, Anthropic, Google, and more", defaultModel: "openai/gpt-6-astra" }
];

export function normalizeModelSettings(value = {}) {
  const provider = typeof value?.provider === "string" ? value.provider.trim() : "";
  const model = typeof value?.model === "string" ? value.model.trim() : "";
  if (provider && !isLocalProvider(provider) && !modelProviders.some((item) => item.id === provider)) throw new Error("Choose a valid provider.");
  if (model.length > 200 || /[\u0000-\u001f]/.test(model)) throw new Error("Choose a valid model.");
  return { provider, model };
}

export function resolveProviderSettings(saved = {}, preferred = {}, env = process.env) {
  const provider = env.UNREAL_HARNESS_LLM_PROVIDER || preferred.provider || saved.provider || "openai-codex";
  const fallback = isLocalProvider(provider) ? "" : modelProviders.find((item) => item.id === provider)?.defaultModel || "gpt-6-astra";
  const model = env.UNREAL_HARNESS_LLM_MODEL || (provider === (saved.provider || "openai-codex") ? saved.model : "") || fallback;
  return { provider, model };
}
