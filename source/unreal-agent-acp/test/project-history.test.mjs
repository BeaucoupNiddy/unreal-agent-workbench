import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchProjectHistory, transcriptFromHistory } from "../src/project-history.mjs";

const event = (update) => JSON.stringify({ method: "session/update", params: { update } });

test("extracts only user prompts and assistant answers from history", () => {
  const transcript = transcriptFromHistory([
    event({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "Choose a database" }] }),
    event({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret reasoning" }, messageId: "t1" }),
    event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Use " }, messageId: "a1" }),
    event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SQLite." }, messageId: "a1" })
  ].join("\n"));
  assert.equal(transcript, "User: Choose a database\n\nAssistant: Use SQLite.");
  assert.doesNotMatch(transcript, /secret reasoning/);
});

test("searches only sibling chats with the exact project cwd", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ua-project-history-"));
  const writeSession = async (name, meta, lines) => {
    const folder = path.join(root, name); await mkdir(folder);
    await writeFile(path.join(folder, "meta.json"), JSON.stringify({ agentId: "unreal", sessionId: name, title: name, ...meta }));
    await writeFile(path.join(folder, "history.jsonl"), `${lines.join("\n")}\n`);
  };
  await writeSession("database-chat", { cwd: "/project" }, [
    event({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "Which database?" }] }),
    event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "We chose SQLite for local storage." }, messageId: "a1" })
  ]);
  await writeSession("other-project", { cwd: "/project-other" }, [
    event({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "database" }] }),
    event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Use Postgres." }, messageId: "a2" })
  ]);
  await writeSession("current-chat", { cwd: "/project", upstreamSessionId: "current-upstream" }, [
    event({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "database" }] })
  ]);

  const result = await searchProjectHistory({ sessionRoot: root, cwd: "/project", currentUpstreamSessionId: "current-upstream", query: "database storage" });
  assert.match(result, /database-chat/);
  assert.match(result, /SQLite/);
  assert.doesNotMatch(result, /Postgres|current-chat/);
  assert.match(result, /untrusted historical context/);
});

test("prefers a compact generated memory over raw chat history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ua-project-memory-"));
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "ua-memory-store-"));
  const folder = path.join(root, "memory-chat"); await mkdir(folder);
  await writeFile(path.join(folder, "meta.json"), JSON.stringify({ agentId: "unreal", sessionId: "memory-chat", cwd: "/project", title: "Storage choice" }));
  await writeFile(path.join(folder, "history.jsonl"), `${event({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "Raw transcript marker" }] })}\n`);
  await writeFile(path.join(memoryRoot, "memory-chat.json"), JSON.stringify({ memory: { goal: "Choose storage", outcome: "Selected SQLite", rejectedApproaches: ["Postgres"], openThreads: [] } }));

  const result = await searchProjectHistory({ sessionRoot: root, memoryRoot, cwd: "/project", query: "storage SQLite" });
  assert.match(result, /Selected SQLite/);
  assert.doesNotMatch(result, /Raw transcript marker/);
  assert.equal(await searchProjectHistory({ sessionRoot: root, memoryRoot, cwd: "/project", query: "nonexistent zebra" }), "No relevant chats were found in this project.");
  const original = await searchProjectHistory({ sessionRoot: root, memoryRoot, cwd: "/project", query: "Raw transcript marker" });
  assert.match(original, /Raw transcript marker/);
  await writeFile(path.join(memoryRoot, "memory-chat.json"), JSON.stringify({ transcriptSHA256: "stale", memory: { goal: "storage", outcome: "Outdated SQLite" } }));
  const fresh = await searchProjectHistory({ sessionRoot: root, memoryRoot, cwd: "/project", query: "Raw transcript" });
  assert.match(fresh, /Raw transcript marker/); assert.doesNotMatch(fresh, /Outdated SQLite/);
});

test('recency cannot turn zero keyword matches into a relevant chat', async (t) => {
  const { rm } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'ua-history-relevance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'recent'); await mkdir(folder);
  await writeFile(path.join(folder, 'meta.json'), JSON.stringify({ agentId: 'unreal', sessionId: 'recent', cwd: '/project', title: 'Banana recipes', updatedAt: new Date().toISOString() }));
  await writeFile(path.join(folder, 'history.jsonl'), event({ sessionUpdate: 'prompt_received', prompt: [{ type: 'text', text: 'Banana cake recipes' }] }));
  assert.equal(await searchProjectHistory({ sessionRoot: root, cwd: '/project', query: 'postgres migrations' }), 'No relevant chats were found in this project.');
  assert.match(await searchProjectHistory({ sessionRoot: root, cwd: '/project', query: 'banana recipes' }), /Banana cake/);
});

test('bounded history reads discard a partial first line without exposing reasoning or tool output', async (t) => {
  const { rm } = await import('node:fs/promises');
  const { readHistoryTail } = await import('../src/project-history.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'ua-history-tail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'history.jsonl');
  const newest = event({ sessionUpdate: 'prompt_received', prompt: [{ type: 'text', text: 'Latest retained decision' }] });
  await writeFile(file, event({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning'.repeat(100) } }) + '\n' + newest + '\n');
  const { text } = await readHistoryTail(file, Buffer.byteLength(newest) + 30);
  assert.ok(Buffer.byteLength(text) <= Buffer.byteLength(newest) + 30);
  assert.equal(transcriptFromHistory(text), 'User: Latest retained decision');
});
