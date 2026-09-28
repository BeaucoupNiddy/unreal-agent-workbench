import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDefaultModel, saveDefaultModel } from "../default-model.mjs";

test("defaults to no preferred model, then saves and clears one", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "default-model-")), "default-model.json");
  assert.deepEqual(await readDefaultModel(file), { provider: "", model: "" });
  assert.deepEqual(await saveDefaultModel(file, { model: " vendor/coder " }), { provider: "", model: "vendor/coder" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { provider: "", model: "vendor/coder" });
  assert.deepEqual(await readDefaultModel(file), { provider: "", model: "vendor/coder" });
  assert.deepEqual(await saveDefaultModel(file, { provider: "", model: "" }), { provider: "", model: "" });
});

test("rejects malformed model values", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "default-model-")), "default-model.json");
  await assert.rejects(saveDefaultModel(file, { model: "x".repeat(201) }), /valid model/);
  await assert.rejects(saveDefaultModel(file, { model: "a\nb" }), /valid model/);
});

test("saves the default provider and its model together, and migrates model-only settings", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "default-provider-")), "default-model.json");
  const settings = { provider: "openrouter", model: "vendor/coder" };
  assert.deepEqual(await saveDefaultModel(file, settings), settings);
  assert.deepEqual(await readDefaultModel(file), settings);
  await writeFile(file, JSON.stringify({ model: "vendor/legacy" }));
  assert.deepEqual(await readDefaultModel(file), { provider: "", model: "vendor/legacy" });
  assert.deepEqual(await saveDefaultModel(file, { provider: "openai-codex", model: "" }), { provider: "openai-codex", model: "" });
  await assert.rejects(saveDefaultModel(file, { provider: "unsupported" }), /valid provider/);
});
