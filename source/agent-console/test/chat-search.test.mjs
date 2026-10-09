import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchableMessages, searchChats } from "../chat-search.mjs";

const event = (update) => JSON.stringify({ method: "session/update", params: { update } });

test("extracts user and assistant messages but not private activity or tool output", () => {
  const lines = [
    event({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "Find the waffle" }, { type: "image", data: "secret" }] }),
    event({ sessionUpdate: "agent_thought_chunk", content: { text: "hidden waffle" } }),
    event({ sessionUpdate: "tool_call_update", content: { text: "secret" } }),
    event({ sessionUpdate: "agent_message_chunk", messageId: "a", content: { text: "Crispy " } }),
    event({ sessionUpdate: "agent_message_chunk", messageId: "a", content: { text: "waffle" } }),
    "incomplete {"
  ];
  assert.deepEqual(searchableMessages(lines.join("\n")), [
    { role: "You", text: "Find the waffle" }, { role: "Assistant", text: "Crispy waffle" }
  ]);
});

test("searches listed chats by title or message, ranks title matches, skips missing history and other agents", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "console-search-"));
  const sessions = [
    { sessionId: "hydra_session_one", title: "First chat", cwd: "/workspace", updatedAt: "2025-01-01", agentId: "unreal" },
    { sessionId: "hydra_session_two", title: "Waffle recipe", cwd: "/workspace", updatedAt: "2024-01-01", agentId: "unreal" },
    { sessionId: "hydra_session_three", title: "Empty", updatedAt: "2026-01-01", agentId: "unreal" },
    { sessionId: "hydra_session_other", title: "Waffle", agentId: "another" },
    { sessionId: "../escape", title: "Waffle", agentId: "unreal" }
  ];
  try {
    await fs.mkdir(path.join(root, sessions[0].sessionId));
    await fs.writeFile(path.join(root, sessions[0].sessionId, "history.jsonl"), [
      event({ sessionUpdate: "prompt_received", prompt: [{ text: "How to bake a WAFFLE today?" }] }),
      event({ sessionUpdate: "agent_thought_chunk", content: { text: "secret" } })
    ].join("\n"));
    assert.deepEqual((await searchChats({ sessions, sessionRoot: root, query: "WAFFLE" })).map((item) => item.sessionId), ["hydra_session_two", "hydra_session_one"]);
    const [result] = await searchChats({ sessions, sessionRoot: root, query: "bake waffle" });
    assert.equal(result.role, "You");
    assert.match(result.snippet, /WAFFLE/);
    assert.deepEqual(await searchChats({ sessions, sessionRoot: root, query: "secret" }), []);
    assert.deepEqual(await searchChats({ sessions, sessionRoot: root, query: "   " }), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
