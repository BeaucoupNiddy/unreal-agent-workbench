#!/usr/bin/env node
import { spawn } from "node:child_process";

let patch = "";
for await (const chunk of process.stdin) patch += chunk.toString("utf8");
if (!patch.trim()) {
  console.error("Usage: unreal-apply-patch < patch.diff");
  process.exit(2);
}
const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
  cwd: process.cwd(),
  stdio: ["pipe", "inherit", "inherit"]
});
child.stdin.end(patch);
child.once("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once("close", (code) => process.exit(code ?? 1));
