import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRunner, validateCommand, commandEnvironment } from "../command-runner.mjs";

// The real sandbox cannot nest inside a sandboxed test runner, so these tests
// launch the shell directly and assert what would have been sandboxed.
const directLaunch = (calls) => async (options) => { calls.push(options); return { command: options.runner, args: options.args }; };

async function workspace(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "command-runner-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function collect() { const frames = []; return { frames, emit: (frame) => frames.push(frame) }; }

test("runs in the chat folder with the chat's mode and streams output", async (t) => {
  const cwd = await workspace(t);
  const calls = [];
  const runner = new CommandRunner({ resolveAccess: async () => ({ cwd, mode: "workspace-write", writableFolders: ["/approved"] }), launch: directLaunch(calls) });
  const { frames, emit } = collect();
  await runner.run("chat", "pwd; echo oops >&2; exit 3", emit);
  assert.deepEqual(frames[0], { type: "start", cwd, mode: "workspace-write" });
  const stdout = frames.filter((f) => f.stream === "stdout").map((f) => f.text).join("");
  const stderr = frames.filter((f) => f.stream === "stderr").map((f) => f.text).join("");
  assert.equal(stdout.trim(), cwd);
  assert.equal(stderr.trim(), "oops");
  const exit = frames.at(-1);
  assert.equal(exit.type, "exit");
  assert.equal(exit.code, 3);
  assert.equal(exit.stopped, false);
  assert.equal(calls[0].mode, "workspace-write");
  assert.equal(calls[0].cwd, cwd);
  assert.deepEqual(calls[0].writableFolders, ["/approved"]);
  assert.equal(calls[0].runner, "/bin/zsh");
  assert.equal(runner.isRunning("chat"), false);
});

test("non-Unreal or unknown chats and invalid commands are refused before launch", async () => {
  const calls = [];
  const runner = new CommandRunner({ resolveAccess: async () => null, launch: directLaunch(calls) });
  await assert.rejects(runner.run("chat", "ls", () => {}), /only for Unreal Agent chats/);
  const badMode = new CommandRunner({ resolveAccess: async () => ({ cwd: "/tmp", mode: "anything" }), launch: directLaunch(calls) });
  await assert.rejects(badMode.run("chat", "ls", () => {}), /only for Unreal Agent chats/);
  await assert.rejects(runner.run("chat", "   ", () => {}), /Type a command/);
  assert.throws(() => validateCommand("a\0b"), /NUL/);
  assert.throws(() => validateCommand("x".repeat(8001)), /8000/);
  assert.equal(calls.length, 0);
  assert.equal(runner.isRunning("chat"), false);
});

test("one command per chat; Stop terminates the whole process group", async (t) => {
  const cwd = await workspace(t);
  const runner = new CommandRunner({ resolveAccess: async () => ({ cwd, mode: "danger-full-access" }), launch: directLaunch([]) });
  const { frames, emit } = collect();
  const running = runner.run("chat", "sleep 30 & echo ready; wait", emit);
  while (!frames.some((f) => f.text?.includes("ready"))) await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(runner.run("chat", "ls", () => {}), /already running/);
  assert.equal(runner.stop("chat"), true);
  await running;
  const exit = frames.at(-1);
  assert.equal(exit.stopped, true);
  assert.ok(exit.signal || exit.code !== 0);
  assert.equal(runner.stop("chat"), false);
});

test("output is capped and long commands time out", async (t) => {
  const cwd = await workspace(t);
  const runner = new CommandRunner({ resolveAccess: async () => ({ cwd, mode: "read-only" }), launch: directLaunch([]),
    limits: { outputBytes: 100, timeoutMs: 300, killGraceMs: 100 } });
  const { frames, emit } = collect();
  await runner.run("chat", "yes | head -c 5000; sleep 30", emit);
  const shown = frames.filter((f) => f.type === "output").reduce((sum, f) => sum + Buffer.byteLength(f.text), 0);
  assert.equal(shown, 100);
  assert.ok(frames.some((f) => f.type === "notice"));
  const exit = frames.at(-1);
  assert.equal(exit.truncated, true);
  assert.equal(exit.timedOut, true);
});

test("commands run non-interactively", () => {
  const env = commandEnvironment({ PATH: "/usr/bin", TERM: "xterm-256color" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.TERM, "dumb");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});
