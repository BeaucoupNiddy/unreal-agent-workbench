import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProviderSettings } from "../src/provider-storage.mjs";

test("copies only shared fields and retains legacy data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "provider-migration-"));
  const current = path.join(root, "Unreal Agent ACP", "provider-settings.json");
  const legacy = path.join(root, "Harness Chat", "settings.json");
  await mkdir(path.dirname(legacy));
  await writeFile(legacy, JSON.stringify({ provider: "openrouter", model: "vendor/model", workspace: "/old" }));
  assert.deepEqual(await readProviderSettings(current, legacy), { provider: "openrouter", model: "vendor/model" });
  assert.equal((await stat(current)).mode & 0o777, 0o600);
  assert.match(await readFile(legacy, "utf8"), /workspace/);
  await writeFile(current, JSON.stringify({ provider: "openai-codex", model: "new" }));
  assert.deepEqual(await readProviderSettings(current, legacy), { provider: "openai-codex", model: "new" });
});

test("missing legacy settings leave the defaults available", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "provider-missing-"));
  assert.deepEqual(await readProviderSettings(path.join(root, "new"), path.join(root, "old")), {});
});
