import { spawn as spawnProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { sandboxLaunch } from "../unreal-agent-acp/src/sandbox.mjs";

export const commandLimits = { length: 8000, outputBytes: 2 * 1024 * 1024, timeoutMs: 10 * 60 * 1000, killGraceMs: 3000 };
const modes = new Set(["read-only", "workspace-write", "danger-full-access"]);

export function validateCommand(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Type a command to run.");
  if (value.length > commandLimits.length) throw new Error(`Commands must be ${commandLimits.length} characters or fewer.`);
  if (value.includes("\0")) throw new Error("Commands cannot contain NUL characters.");
  return value.trim();
}

// Non-interactive: no stdin, no pager, no colour, no credential prompts.
export function commandEnvironment(base = process.env) {
  return { ...base, TERM: "dumb", NO_COLOR: "1", CLICOLOR: "0", PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
}

// Manual commands from the Console use the chat's own folder and saved
// permission mode, through the same sandbox profile the agent receives.
// Full access is only persisted after the user approved it for that chat.
export class CommandRunner {
  constructor({ resolveAccess, spawn = spawnProcess, launch = sandboxLaunch, limits = commandLimits }) {
    this.resolveAccess = resolveAccess;
    this.spawn = spawn;
    this.launch = launch;
    this.limits = { ...commandLimits, ...limits };
    this.running = new Map();
  }

  isRunning(sessionId) { return this.running.has(sessionId); }

  async run(sessionId, command, emit) {
    const text = validateCommand(command);
    if (this.running.has(sessionId)) throw new Error("A command is already running in this chat. Stop it first.");
    const run = { child: null, stopped: false, timedOut: false };
    this.running.set(sessionId, run); // Reserve before awaiting so a second request cannot race in.
    try {
      const access = await this.resolveAccess(sessionId);
      if (!access?.cwd || !modes.has(access.mode)) throw new Error("Run command is available only for Unreal Agent chats.");
      const launch = await this.launch({ mode: access.mode, runner: "/bin/zsh", args: ["-lc", text],
        cwd: access.cwd, dataDir: tmpdir(), writableFolders: access.writableFolders || [] });
      if (run.stopped) throw new Error("Stopped before the command started.");
      const started = Date.now();
      emit({ type: "start", cwd: access.cwd, mode: access.mode });
      return await new Promise((resolve) => {
        let sent = 0, truncated = false, killTimer = null, done = false;
        const child = run.child = this.spawn(launch.command, launch.args, {
          cwd: access.cwd, env: commandEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: true
        });
        const forward = (stream) => (chunk) => {
          if (truncated) return;
          const room = this.limits.outputBytes - sent;
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          sent += part.length;
          if (part.length) emit({ type: "output", stream, text: part.toString("utf8") });
          if (chunk.length > room) { truncated = true; emit({ type: "notice", text: "Output limit reached; further output is hidden." }); }
        };
        child.stdout?.on("data", forward("stdout"));
        child.stderr?.on("data", forward("stderr"));
        const timeout = setTimeout(() => { run.timedOut = true; this.stop(sessionId); }, this.limits.timeoutMs);
        run.terminate = () => {
          signalGroup(child, "SIGTERM");
          killTimer ||= setTimeout(() => signalGroup(child, "SIGKILL"), this.limits.killGraceMs);
        };
        const finish = (event) => {
          if (done) return;
          done = true;
          clearTimeout(timeout); clearTimeout(killTimer);
          emit({ ...event, durationMs: Date.now() - started, truncated, stopped: run.stopped, timedOut: run.timedOut });
          resolve(event);
        };
        child.on("error", (error) => finish({ type: "exit", code: null, signal: null, error: error.message }));
        child.on("close", (code, signal) => finish({ type: "exit", code, signal }));
      });
    } finally {
      if (this.running.get(sessionId) === run) this.running.delete(sessionId);
    }
  }

  stop(sessionId) {
    const run = this.running.get(sessionId);
    if (!run) return false;
    run.stopped = true;
    run.terminate?.();
    return true;
  }

  stopAll() { for (const sessionId of this.running.keys()) this.stop(sessionId); }
}

function signalGroup(child, signal) {
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}
