import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotWorkspace, workspaceDiff } from "../src/workspace.mjs";

test("skips Unreal generated folders and opaque assets when snapshotting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unreal-workspace-assets-"));
  await mkdir(path.join(root, "Source"), { recursive: true });
  await mkdir(path.join(root, "Intermediate"), { recursive: true });
  await mkdir(path.join(root, "Saved"), { recursive: true });
  await mkdir(path.join(root, "Content"), { recursive: true });
  await writeFile(path.join(root, "Source", "Actor.cpp"), "void Act() {}\n");
  await writeFile(path.join(root, "Intermediate", "build.log"), "generated\n");
  await writeFile(path.join(root, "Saved", "report.txt"), "generated\n");
  await writeFile(path.join(root, "Content", "Map.umap"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "Content", "readme.txt"), "keep this\n");

  const snapshot = await snapshotWorkspace(root);
  assert.deepEqual([...snapshot.keys()].sort(), ["Content/readme.txt", "Source/Actor.cpp"]);
});

test("reports native ACP diffs without including pre-existing changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unreal-workspace-"));
  const file = path.join(root, "app.js");
  await writeFile(file, "const value = 1;\n");
  const before = await snapshotWorkspace(root);
  await writeFile(file, "const value = 2;\n");
  await writeFile(path.join(root, "new.txt"), "hello\n");
  const changes = workspaceDiff(before, await snapshotWorkspace(root));
  assert.deepEqual(changes.map((change) => path.basename(change.path)), ["app.js", "new.txt"]);
  assert.equal(changes[0].oldText, "const value = 1;\n");
  assert.equal(changes[0].newText, "const value = 2;\n");
  assert.equal(changes[1].oldText, null);
});

test("reuses unchanged snapshot content and rereads changed files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unreal-workspace-cache-"));
  const file = path.join(root, "app.js");
  await writeFile(file, "one\n");
  const first = await snapshotWorkspace(root);
  const second = await snapshotWorkspace(root, first);
  assert.equal(second.get("app.js"), first.get("app.js"));
  await writeFile(file, "two and changed size\n");
  const third = await snapshotWorkspace(root, second);
  assert.notEqual(third.get("app.js"), second.get("app.js"));
  assert.equal(third.get("app.js").text, "two and changed size\n");
});
