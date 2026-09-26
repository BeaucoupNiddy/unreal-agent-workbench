import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGenerationSettings, normalizeGenerationSettings, readGenerationSettings, saveGenerationSettings } from "../generation-settings.mjs";

test("generation settings default to Luna 6 with both features enabled", () => {
  assert.deepEqual(normalizeGenerationSettings(), defaultGenerationSettings);
});

test("generation settings preserve switches and reject unknown models", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ua-generation-settings-"));
  const file = path.join(root, "settings.json");
  await saveGenerationSettings(file, { memoryEnabled: false, memoryModel: "unknown", titleEnabled: false, titleModel: "gpt-6-astra" });
  assert.deepEqual(await readGenerationSettings(file), {
    memoryEnabled: false, memoryModel: "gpt-6-luna", titleEnabled: false, titleModel: "gpt-6-astra"
  });
});
