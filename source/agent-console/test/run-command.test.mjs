import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, parseFrames, exitSummary, rememberCommand, commandSnippet, modeLabel } from "../public/run-command.js";

test("streamed frames are split on complete lines only", () => {
  const first = parseFrames('{"type":"start","mode":"read-only"}\n{"type":"output","te');
  assert.deepEqual(first.frames, [{ type: "start", mode: "read-only" }]);
  const second = parseFrames(`${first.rest}xt":"hi"}\n`);
  assert.deepEqual(second.frames, [{ type: "output", text: "hi" }]);
  assert.equal(second.rest, "");
});

test("terminal escapes are removed so output stays plain text", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07ok"), "red ok");
  assert.equal(stripAnsi("10%\r50%\r\n"), "10%\n50%\r\n");
});

test("exit summaries describe how the command ended", () => {
  assert.equal(exitSummary({ code: 0, durationMs: 1234 }), "Exit 0 · 1.2s");
  assert.equal(exitSummary({ code: null, signal: "SIGTERM", stopped: true, durationMs: 500 }), "Stopped after 0.5s");
  assert.equal(exitSummary({ stopped: true, timedOut: true, durationMs: 600000 }), "Timed out after 600.0s");
  assert.match(exitSummary({ error: "spawn ENOENT" }), /Could not start/);
  assert.equal(modeLabel("danger-full-access"), "Full computer access");
});

test("history is most-recent-first, de-duplicated and bounded", () => {
  let history = [];
  for (let i = 0; i < 40; i += 1) history = rememberCommand(history, `cmd ${i}`);
  history = rememberCommand(history, "cmd 35");
  assert.equal(history.length, 30);
  assert.equal(history[0], "cmd 35");
  assert.equal(history.filter((item) => item === "cmd 35").length, 1);
});

test("snippets for the agent keep the command, the tail of output and the result", () => {
  assert.equal(commandSnippet("git status", "clean\n", "Exit 0 · 0.1s"), "```text\n$ git status\nclean\n# Exit 0 · 0.1s\n```");
  const long = commandSnippet("npm test", `${"a".repeat(20000)}END`, "Exit 1 · 2.0s");
  assert.match(long, /earlier output omitted/);
  assert.match(long, /END\n# Exit 1/);
  assert.ok(commandSnippet("cat x.md", "```js\n```", "Exit 0 · 0.0s").startsWith("~~~~text"));
});
