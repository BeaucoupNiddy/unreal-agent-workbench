import assert from "node:assert/strict";
import test from "node:test";
import { taskStatus } from "../public/task-state.js";

const connected = { ready: true, chat: true };

test("distinguishes connection, project, idle, and failures", () => {
  assert.equal(taskStatus({ chat: true, connection: "Opening chat…" }).label, "Opening chat…");
  assert.equal(taskStatus({ ...connected, ready: false, connection: "Reconnecting", running: true, entries: [{ type: "permission" }] }).label, "Reconnecting…");
  assert.equal(taskStatus({ ...connected, ready: false, connection: "Task unavailable" }).kind, "error");
  assert.equal(taskStatus({ ready: true, project: true }).label, "Ready to start");
  assert.equal(taskStatus(connected).label, "Ready for a message");
  assert.deepEqual(taskStatus({ ...connected, error: "Provider timed out" }), { kind: "error", label: "Task failed", detail: "Provider timed out" });
});

test("approvals and stopping take precedence over active tools", () => {
  const entries = [{ type: "tool", status: "in_progress", kind: "edit" }, { type: "permission" }];
  assert.equal(taskStatus({ ...connected, running: true, entries }).label, "Approval needed");
  assert.equal(taskStatus({ ...connected, running: true, stopping: true, entries }).label, "Stopping task…");
  assert.equal(taskStatus({ ...connected, entries }).label, "Approval needed");
});

test("reports tool work without exposing raw command text and counts parallel tools", () => {
  const entries = [
    { type: "message", role: "user" },
    { type: "tool", kind: "execute", status: "in_progress", input: { command: "npm test -- --token SECRET" } },
    { type: "tool", kind: "edit", status: "pending", title: "2 files changed" }
  ];
  assert.deepEqual(taskStatus({ ...connected, running: true, entries }), { kind: "working", label: "Editing files", detail: "2 tools active" });
  entries[2].status = "completed";
  assert.equal(taskStatus({ ...connected, running: true, entries }).label, "Running tests");
  entries[1].status = "completed";
  assert.equal(taskStatus({ ...connected, running: true, entries }).label, "Working on your request…");
});

test("describes composing, thinking, writing, and sending", () => {
  assert.equal(taskStatus({ ...connected, submitting: true }).label, "Sending message…");
  assert.equal(taskStatus({ ...connected, running: true, entries: [{ type: "thought" }] }).label, "Thinking through the request…");
  assert.equal(taskStatus({ ...connected, running: true, entries: [{ type: "message", role: "agent" }] }).label, "Writing a response…");
  assert.equal(taskStatus({ ...connected, running: true, submitting: true, entries: [{ type: "tool", status: "pending", kind: "read" }] }).label, "Inspecting project");
});
