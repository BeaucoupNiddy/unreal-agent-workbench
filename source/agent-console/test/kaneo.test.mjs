import assert from "node:assert/strict";
import test from "node:test";
import { KaneoClient, normalizeKaneoUrl, readKaneoKey, saveKaneoKey, verifyKaneoKey } from "../kaneo.mjs";
import { availableTools, createTools, handleMessage } from "../kaneo-mcp.mjs";

// A small in-memory Kaneo that follows the API's label model: workspace labels
// have no taskId, and attaching one to a task creates a task-owned copy.
function fakeKaneo({ key = "kaneo-test-key-123456", workspaces = [{ id: "w1", name: "Home", slug: "home", role: "owner" }], legacy = false } = {}) {
  const calls = [];
  const db = {
    projects: [{ id: "p1", workspaceId: "w1", name: "Web", slug: "WEB" }, { id: "p2", workspaceId: "w1", name: "Ops", slug: "OPS" }],
    columns: { p1: [{ slug: "to-do", name: "To do" }, { slug: "done", name: "Done", isFinal: true }], p2: [{ slug: "backlog", name: "Backlog" }] },
    tasks: [{ id: "t1", projectId: "p1", number: 12, title: "Fix login", description: "Steps", status: "to-do", priority: "high", userId: null, dueDate: "2026-10-20" }],
    labels: [{ id: "l1", name: "Bug", color: "#f00", taskId: null, workspaceId: "w1" }],
    deletes: 0
  };
  let next = 1;
  const send = (status, value) => new Response(value === undefined ? "" : JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const withWorkspace = (task) => ({ ...task, workspaceId: db.projects.find((p) => p.id === task.projectId).workspaceId });
  async function fetch(url, init) {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: pathname, query: Object.fromEntries(searchParams), body });
    if (init.headers.Authorization !== `Bearer ${key}`) return send(401, { message: "Unauthorized" });
    const route = `${init.method} ${pathname.replace(/^\/api/, "")}`;
    let match;
    if (route === "GET /user/me") return send(200, { id: "u1", name: "Pat", email: "pat@example.com" });
    if (route === "GET /workspace") return legacy ? new Response("404 Not Found", { status: 404 }) : send(200, workspaces);
    if (route === "GET /auth/organization/list") return send(200, workspaces.map(({ role, ...rest }) => rest));
    if (route === "GET /project") return send(200, db.projects.filter((p) => p.workspaceId === searchParams.get("workspaceId"))
      .map((p) => ({ ...p, columns: legacy ? [] : db.columns[p.id], statistics: { total: 1 } })));
    if ((match = route.match(/^GET \/column\/(\w+)$/))) return send(200, db.columns[match[1]]);
    if ((match = route.match(/^GET \/task\/tasks\/(\w+)$/))) {
      const project = db.projects.find((p) => p.id === match[1]);
      return send(200, { data: { ...project, columns: db.columns[project.id].map((column) => ({ ...column,
        tasks: db.tasks.filter((t) => t.projectId === project.id && t.status === column.slug) })), archivedTasks: [], plannedTasks: [] },
      pagination: { page: 1, totalPages: 1, total: 1 } });
    }
    if ((match = route.match(/^GET \/task\/by-ticket-id\/([\w-]+)$/))) {
      const [slug, number] = match[1].split("-");
      const project = db.projects.find((p) => p.slug === slug);
      const task = db.tasks.find((t) => t.projectId === project?.id && t.number === Number(number));
      return task ? send(200, withWorkspace(task)) : send(404, { message: "Task not found" });
    }
    if ((match = route.match(/^GET \/task\/(\w+)$/))) {
      const task = db.tasks.find((t) => t.id === match[1]);
      return task ? send(200, withWorkspace(task)) : send(404, { message: "Task not found" });
    }
    if ((match = route.match(/^POST \/task\/(\w+)$/))) {
      const task = { id: `t${++next}`, projectId: match[1], number: next, userId: null, dueDate: null, ...body };
      db.tasks.push(task); return send(200, task);
    }
    if ((match = route.match(/^PUT \/task\/(title|description|status|priority|due-date|assignee)\/(\w+)$/))) {
      const task = db.tasks.find((t) => t.id === match[2]);
      if (match[1] === "due-date") task.dueDate = body.dueDate ?? null;
      else if (match[1] === "assignee") task.userId = body.userId;
      else Object.assign(task, body);
      return send(200, task);
    }
    if ((match = route.match(/^PUT \/task\/move\/(\w+)$/))) {
      const task = db.tasks.find((t) => t.id === match[1]);
      const source = task.projectId;
      task.projectId = body.destinationProjectId; task.status = body.destinationStatus || db.columns[task.projectId][0].slug;
      return send(200, { task, sourceProjectId: source, destinationProjectId: task.projectId });
    }
    if ((match = route.match(/^POST \/comment\/(\w+)$/))) return send(200, { id: "c1", taskId: match[1], createdAt: "now", content: body.content });
    if ((match = route.match(/^GET \/label\/workspace\/(\w+)$/))) return send(200, db.labels.filter((l) => l.workspaceId === match[1]));
    if ((match = route.match(/^GET \/label\/task\/(\w+)$/))) return send(200, db.labels.filter((l) => l.taskId === match[1]));
    if (route === "POST /label") {
      const label = { id: `l${++next}`, taskId: null, ...body }; db.labels.push(label); return send(200, label);
    }
    if ((match = route.match(/^PUT \/label\/(\w+)\/task$/))) {
      const template = db.labels.find((l) => l.id === match[1]);
      const copy = { id: `l${++next}`, name: template.name, color: template.color, workspaceId: template.workspaceId, taskId: body.taskId };
      db.labels.push(copy); return send(200, copy);
    }
    if ((match = route.match(/^DELETE \/label\/(\w+)\/task$/))) {
      const label = db.labels.find((l) => l.id === match[1]);
      if (!label?.taskId) return send(400, { message: "Label is not assigned to a task" });
      db.labels = db.labels.filter((l) => l !== label); return send(200, label);
    }
    if ((match = route.match(/^GET \/label\/(\w+)$/))) return send(200, db.labels.find((l) => l.id === match[1]));
    if ((match = route.match(/^PUT \/label\/(\w+)$/))) {
      const label = db.labels.find((l) => l.id === match[1]); Object.assign(label, body); return send(200, label);
    }
    if ((match = route.match(/^DELETE \/label\/(\w+)$/))) {
      db.deletes += 1;
      if (db.deletes < 3) return send(202, { id: match[1] });
      const label = db.labels.find((l) => l.id === match[1]); db.labels = db.labels.filter((l) => l.name !== label.name);
      return send(200, label);
    }
    if (route === "GET /search") return send(200, { totalCount: 1, searchQuery: searchParams.get("q"),
      results: [{ id: "t1", type: "task", title: "Fix login", projectId: "p1", projectName: "Web", projectSlug: "WEB", taskNumber: 12, status: "to-do", relevanceScore: 1, createdAt: "now" }] });
    return send(404, { message: `No route ${route}` });
  }
  return { fetch, calls, db, key };
}

function tools(fake = fakeKaneo()) {
  return { fake, tools: createTools(new KaneoClient({ baseUrl: "https://kaneo.example", apiKey: fake.key, fetch: fake.fetch })) };
}
const run = (tool, args = {}) => tool(args, { signal: new AbortController().signal });

test("addresses become the /api base without credentials or queries", () => {
  assert.equal(normalizeKaneoUrl("https://cloud.kaneo.app"), "https://cloud.kaneo.app/api");
  assert.equal(normalizeKaneoUrl("https://tasks.example.com/kaneo/?x=1#top"), "https://tasks.example.com/kaneo/api");
  assert.equal(normalizeKaneoUrl(""), "");
  assert.throws(() => normalizeKaneoUrl("https://user:pass@kaneo.example"), /without a user name/);
});

test("the key is kept in the keychain and an environment key takes precedence", async () => {
  const saved = [];
  const security = async (args) => { saved.push(args); return { stdout: "from-keychain\n" }; };
  await saveKaneoKey(" kaneo-test-key-123456 ", { security });
  assert.deepEqual(saved[0].slice(0, 2), ["add-generic-password", "-U"]);
  assert.equal(saved[0].at(-1), "kaneo-test-key-123456");
  assert.equal(await readKaneoKey({ security, env: {} }), "from-keychain");
  assert.equal(await readKaneoKey({ security, env: { KANEO_API_KEY: "env-key" } }), "env-key");
  assert.equal(await readKaneoKey({ security: async () => { throw new Error("missing"); }, env: {} }), "");
  await assert.rejects(saveKaneoKey("short", { security }), /incomplete/);
});

test("keys are verified with Bearer auth and network failures are not rejections", async () => {
  const fake = fakeKaneo();
  assert.deepEqual(await verifyKaneoKey("https://kaneo.example", fake.key, { fetch: fake.fetch }), { valid: true, checked: true, user: "Pat" });
  assert.equal(fake.calls[0].path, "/api/user/me");
  assert.deepEqual(await verifyKaneoKey("https://kaneo.example", "wrong-key-123456789", { fetch: fake.fetch }), { valid: false, checked: true });
  const offline = await verifyKaneoKey("https://kaneo.example", fake.key, { fetch: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(offline.valid, true); assert.equal(offline.checked, false);
});

test("a missing key or rejected key explains where to fix it", async () => {
  const fake = fakeKaneo();
  const noKey = createTools(new KaneoClient({ baseUrl: "https://kaneo.example", apiKey: "", fetch: fake.fetch }));
  await assert.rejects(run(noKey.kaneo_workspaces), /Settings > Capabilities/);
  const badKey = createTools(new KaneoClient({ baseUrl: "https://kaneo.example", apiKey: "nope-nope-nope-nope", fetch: fake.fetch }));
  await assert.rejects(run(badKey.kaneo_workspaces), /rejected the API key/);
});

test("projects resolve the only workspace and list status slugs", async () => {
  const { tools: kaneo } = tools();
  const result = await run(kaneo.kaneo_projects);
  assert.equal(result.workspaceId, "w1");
  assert.deepEqual(result.projects.map((p) => [p.name, p.statuses]), [["Web", ["to-do", "done"]], ["Ops", ["backlog"]]]);
  const two = tools(fakeKaneo({ workspaces: [{ id: "w1", name: "Home" }, { id: "w2", name: "Work" }] }));
  const all = await run(two.tools.kaneo_projects);
  assert.deepEqual(all.workspaces.map((w) => [w.workspace, w.projects.length]), [["Home", 2], ["Work", 0]]);
  await assert.rejects(run(two.tools.kaneo_labels), /Choose a workspaceId: Home \(w1\), Work \(w2\)/);
});

test("older Kaneo releases list workspaces as organizations and columns per project", async () => {
  const { tools: kaneo, fake } = tools(fakeKaneo({ legacy: true }));
  assert.deepEqual((await run(kaneo.kaneo_workspaces)).workspaces, [{ id: "w1", name: "Home", slug: "home" }]);
  const result = await run(kaneo.kaneo_projects);
  assert.deepEqual(result.projects.map((p) => [p.name, p.statuses]), [["Web", ["to-do", "done"]], ["Ops", ["backlog"]]]);
  assert.ok(fake.calls.some((c) => c.path === "/api/column/p2"));
});

test("tasks list compactly by column and resolve ticket IDs", async () => {
  const { tools: kaneo } = tools();
  const board = await run(kaneo.kaneo_tasks, { projectId: "p1" });
  assert.deepEqual(board.columns.map((c) => [c.status, c.tasks.map((t) => t.title)]), [["to-do", ["Fix login"]], ["done", []]]);
  const { task } = await run(kaneo.kaneo_get_task, { taskId: "WEB-12" });
  assert.equal(task.id, "t1"); assert.equal(task.description, "Steps"); assert.deepEqual(task.labels, []);
  const search = await run(kaneo.kaneo_search, { query: "login" });
  assert.equal(search.results[0].ticket, "WEB-12");
});

test("creating a task defaults to the first column and attaches labels by name", async () => {
  const { tools: kaneo, fake } = tools();
  const { task } = await run(kaneo.kaneo_create_task, { projectId: "p1", title: "Write docs", labels: ["Bug", "Docs"] });
  assert.equal(task.status, "to-do");
  assert.deepEqual(task.labels, ["Bug", "Docs"]);
  const create = fake.calls.find((c) => c.method === "POST" && c.path === "/api/task/p1");
  assert.deepEqual(create.body, { title: "Write docs", description: "", priority: "no-priority", status: "to-do" });
  assert.ok(fake.db.labels.some((l) => l.name === "Docs" && !l.taskId), "missing workspace label is created");
  assert.equal(fake.db.labels.filter((l) => l.taskId === task.id).length, 2);
});

test("updates touch only the fields given, through Kaneo's single-field routes", async () => {
  const { tools: kaneo, fake } = tools();
  const result = await run(kaneo.kaneo_update_task, { taskId: "t1", priority: "low", dueDate: "", assigneeId: null });
  assert.deepEqual(result.changed, ["priority", "due-date", "assignee"]);
  assert.equal(fake.db.tasks[0].title, "Fix login");
  assert.equal(fake.db.tasks[0].dueDate, null);
  assert.ok(!fake.calls.some((c) => c.method === "PUT" && c.path === "/api/task/t1"), "never replaces the whole task");
  await assert.rejects(run(kaneo.kaneo_update_task, { taskId: "t1" }), /at least one field/);
});

test("moving uses the project move route across projects and the status route within one", async () => {
  const { tools: kaneo, fake } = tools();
  const within = await run(kaneo.kaneo_move_task, { taskId: "WEB-12", status: "done" });
  assert.equal(within.moved, "status"); assert.equal(within.task.status, "done");
  const across = await run(kaneo.kaneo_move_task, { taskId: "t1", projectId: "p2" });
  assert.equal(across.moved, "project"); assert.equal(across.from, "p1"); assert.equal(across.task.projectId, "p2");
  assert.deepEqual(fake.calls.find((c) => c.path === "/api/task/move/t1").body, { destinationProjectId: "p2" });
  await assert.rejects(run(kaneo.kaneo_move_task, { taskId: "t1" }), /destination/);
});

test("labels attach as task copies and are removed by the copy, not the workspace label", async () => {
  const { tools: kaneo, fake } = tools();
  await run(kaneo.kaneo_add_label, { taskId: "t1", labelId: "l1" });
  const removed = await run(kaneo.kaneo_remove_label, { taskId: "t1", labelId: "l1" });
  assert.equal(removed.removed, "Bug");
  assert.ok(fake.db.labels.some((l) => l.id === "l1"), "workspace label survives");
  assert.equal(fake.db.labels.filter((l) => l.taskId === "t1").length, 0);
  await assert.rejects(run(kaneo.kaneo_remove_label, { taskId: "t1", name: "Bug" }), /not on this task/);
});

test("label management lists, updates, and finishes batched deletes", async () => {
  const { tools: kaneo, fake } = tools();
  assert.deepEqual((await run(kaneo.kaneo_labels)).labels.map((l) => l.name), ["Bug"]);
  assert.equal((await run(kaneo.kaneo_create_label, { name: "Ops" })).label.color, "#6b7280");
  assert.deepEqual((await run(kaneo.kaneo_update_label, { labelId: "l1", color: "#0f0" })).label, { id: "l1", name: "Bug", color: "#0f0" });
  const deleted = await run(kaneo.kaneo_delete_label, { labelId: "l1" });
  assert.equal(deleted.deleted.name, "Bug"); assert.equal(fake.db.deletes, 3);
});

test("comments are posted to the resolved task", async () => {
  const { tools: kaneo, fake } = tools();
  const result = await run(kaneo.kaneo_add_comment, { taskId: "WEB-12", content: "Done in PR" });
  assert.equal(result.comment.taskId, "t1");
  assert.deepEqual(fake.calls.at(-1).body, { content: "Done in PR" });
});

test("tool discovery marks reads as read-only and only label deletion as destructive", async () => {
  const list = availableTools();
  assert.equal(new Set(list.map((t) => t.name)).size, list.length);
  assert.deepEqual(list.filter((t) => t.annotations.readOnlyHint).map((t) => t.name),
    ["kaneo_workspaces", "kaneo_projects", "kaneo_tasks", "kaneo_get_task", "kaneo_search", "kaneo_labels"]);
  assert.deepEqual(list.filter((t) => t.annotations.destructiveHint).map((t) => t.name), ["kaneo_delete_label"]);
  for (const tool of list) assert.ok(Object.hasOwn(createTools({}), tool.name), `${tool.name} has a handler`);
  const result = await handleMessage({ id: 1, method: "tools/call", params: { name: "kaneo_workspaces" } }, async () => ({ workspaces: [] }), new Map());
  assert.deepEqual(result.structuredContent, { workspaces: [] });
  assert.equal((await handleMessage({ method: "initialize" })).serverInfo.name, "kaneo");
});
