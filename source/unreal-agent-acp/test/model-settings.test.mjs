import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderSettings } from "../src/model-settings.mjs";

test("changing providers uses a model from the chosen provider instead of the previous connection", () => {
  assert.deepEqual(resolveProviderSettings({ provider: "openrouter", model: "vendor/coder" }, { provider: "openai-codex" }, {}),
    { provider: "openai-codex", model: "gpt-6-astra" });
  assert.deepEqual(resolveProviderSettings({ provider: "openai-codex", model: "gpt-6-luna" }, { provider: "openrouter" }, {}),
    { provider: "openrouter", model: "openai/gpt-6-astra" });
});

test("keeps the existing connection until a provider preference is saved", () => {
  assert.deepEqual(resolveProviderSettings({ provider: "openrouter", model: "vendor/coder" }, { model: "vendor/other" }, {}),
    { provider: "openrouter", model: "vendor/coder" });
});

test("explicit environment overrides still win over saved provider preferences", () => {
  assert.deepEqual(resolveProviderSettings({ provider: "openrouter", model: "vendor/coder" }, { provider: "openrouter" },
    { UNREAL_HARNESS_LLM_PROVIDER: "openai-codex", UNREAL_HARNESS_LLM_MODEL: "gpt-6-luna" }),
    { provider: "openai-codex", model: "gpt-6-luna" });
});
