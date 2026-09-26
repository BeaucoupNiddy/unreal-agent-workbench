import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

function quoteSandboxLiteral(value) {
  return `\"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}\"`;
}

export async function sandboxLaunch({ mode, runner, args, cwd, dataDir }) {
  if (mode === "danger-full-access" || process.platform !== "darwin") {
    if (mode === "danger-full-access") return { command: runner, args };
    throw new Error("Workspace and read-only confinement currently require macOS sandbox-exec.");
  }
  const realpathOrResolved = async (value) => fs.realpath(value).catch(() => path.resolve(value));
  const [workspace, storage, temporary] = await Promise.all([
    realpathOrResolved(cwd), realpathOrResolved(dataDir), realpathOrResolved(tmpdir())
  ]);
  const caches = [path.join(homedir(), ".npm"), path.join(homedir(), ".cache"), path.join(homedir(), "Library", "Caches")];
  const writable = mode === "workspace-write"
    ? [workspace, storage, temporary, ...caches]
    : [storage, temporary, ...caches];
  const text = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    ...writable.map((directory) => `(allow file-write* (subpath ${quoteSandboxLiteral(directory)}))`),
    "(allow file-write* (literal \"/dev/null\") (literal \"/dev/tty\"))",
    ""
  ].join("\n");
  return { command: "/usr/bin/sandbox-exec", args: ["-p", text, runner, ...args], profile: text };
}
