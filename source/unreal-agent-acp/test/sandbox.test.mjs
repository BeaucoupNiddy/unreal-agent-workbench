import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { sandboxLaunch } from "../src/sandbox.mjs";

test("uses a session-local inline profile with the real workspace and temp directory", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unreal-sandbox-"));
  const dataDir = path.join(root, "data");
  const launch = await sandboxLaunch({ mode: "workspace-write", runner: "/bin/echo", args: ["ok"], cwd: root, dataDir });
  assert.equal(launch.command, "/usr/bin/sandbox-exec");
  assert.deepEqual(launch.args.slice(0, 2), ["-p", launch.profile]);
  assert.match(launch.profile, new RegExp((await realpath(root)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(launch.profile, new RegExp((await realpath(tmpdir())).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(launch.profile, /Library\\?"?,? Caches|Library\/Caches/);
});
