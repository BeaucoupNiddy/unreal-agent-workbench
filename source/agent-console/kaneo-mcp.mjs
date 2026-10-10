#!/usr/bin/env node
// Lazy stdio MCP server for Kaneo tasks, labels and projects. The instance URL
// arrives as KANEO_BASE_URL; the API key is read from the keychain per call.
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { KaneoClient, readKaneoKey } from "./kaneo.mjs";

const priorities = ["no-priority", "low", "medium", "high", "urgent"];
const id = { type: "string" };
const taskRef = { type: "string", description: "Task ID, or its ticket ID such as WEB-12." };
const workspaceRef = { type: "string", description: "Workspace ID. Optional when the key can see only one workspace." };
const dateText = { type: "string", description: "ISO-8601 date or date/time." };
const object = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });

const definitions = [
  ["kaneo_workspaces", "List the Kaneo workspaces this API key can see.", object({}), true],
  ["kaneo_projects", "List projects with their columns (status slugs) and task counts, in one workspace or, by default, every workspace.",
    object({ workspaceId: { type: "string", description: "Limit to one workspace." }, includeArchived: { type: "boolean" } }), true],
  ["kaneo_tasks", "List a project's tasks grouped by column. Filter by status slug, priority or assignee; page through large boards.",
    object({ projectId: id, status: { type: "string" }, priority: { type: "string", enum: priorities }, assigneeId: id,
      page: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["projectId"]), true],
  ["kaneo_get_task", "Read one task with its description and labels.", object({ taskId: taskRef }, ["taskId"]), true],
  ["kaneo_search", "Search tasks, projects and comments in a workspace.",
    object({ query: { type: "string" }, workspaceId: workspaceRef, projectId: id,
      type: { type: "string", enum: ["all", "tasks", "projects", "comments"] }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["query"]), true],
  ["kaneo_labels", "List a workspace's labels, or the labels on one task when taskId is given.",
    object({ workspaceId: workspaceRef, taskId: taskRef }), true],
  ["kaneo_create_task", "Create a task in a project. Status is a column slug from kaneo_projects; it defaults to the first column.",
    object({ projectId: id, title: { type: "string" }, description: { type: "string", description: "Markdown." },
      status: { type: "string" }, priority: { type: "string", enum: priorities }, dueDate: dateText, startDate: dateText,
      assigneeId: { type: "string", description: "Kaneo user ID." },
      labels: { type: "array", items: { type: "string" }, description: "Label names to attach; missing workspace labels are created." } },
    ["projectId", "title"]), false],
  ["kaneo_update_task", "Change a task's title, description, status (column slug), priority, due date or assignee. Only the fields given change. Pass an empty dueDate to clear it and a null assigneeId to unassign.",
    object({ taskId: taskRef, title: { type: "string" }, description: { type: "string" }, status: { type: "string" },
      priority: { type: "string", enum: priorities }, dueDate: { type: "string" }, assigneeId: { type: ["string", "null"] } }, ["taskId"]), false],
  ["kaneo_move_task", "Move a task to another project in the same workspace, or to another column. Give projectId, status, or both.",
    object({ taskId: taskRef, projectId: { type: "string", description: "Destination project ID." },
      status: { type: "string", description: "Destination column slug." } }, ["taskId"]), false],
  ["kaneo_add_comment", "Add a comment to a task.", object({ taskId: taskRef, content: { type: "string" } }, ["taskId", "content"]), false],
  ["kaneo_create_label", "Create a workspace label.", object({ name: { type: "string" }, color: { type: "string", description: "Hex color such as #3b82f6." }, workspaceId: workspaceRef }, ["name"]), false],
  ["kaneo_update_label", "Rename or recolor a workspace label.", object({ labelId: id, name: { type: "string" }, color: { type: "string" } }, ["labelId"]), false],
  ["kaneo_delete_label", "Delete a workspace label and remove it from every task.", object({ labelId: id }, ["labelId"]), false],
  ["kaneo_add_label", "Attach a label to a task by label ID or name. A missing name creates the workspace label first.",
    object({ taskId: taskRef, labelId: id, name: { type: "string" }, color: { type: "string" } }, ["taskId"]), false],
  ["kaneo_remove_label", "Remove a label from a task by label ID or name. The workspace label is kept.",
    object({ taskId: taskRef, labelId: id, name: { type: "string" } }, ["taskId"]), false]
];

export function availableTools() {
  return definitions.map(([name, description, inputSchema, readOnly]) => ({
    name, description, inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: name === "kaneo_delete_label", idempotentHint: readOnly }
  }));
}

const ticketPattern = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const defaultLabelColor = "#6b7280";

function compactTask(task, column) {
  if (!task) return task;
  const out = { id: task.id, number: task.number, title: task.title, status: task.status,
    ...(column ? { column } : {}), priority: task.priority, projectId: task.projectId,
    assignee: task.assigneeName || undefined, assigneeId: task.assigneeId || task.userId || undefined,
    dueDate: task.dueDate || undefined, startDate: task.startDate || undefined };
  if (Array.isArray(task.labels) && task.labels.length) out.labels = task.labels.map((label) => label.name || label);
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined && value !== null));
}

const compactLabel = (label) => ({ id: label.id, name: label.name, color: label.color, ...(label.taskId ? { taskId: label.taskId } : {}) });

export function createTools(client) {
  // Some Kaneo releases have no /workspace route; workspaces are Better Auth organizations there.
  async function listWorkspaces(signal) {
    try { return await client.get("/workspace", undefined, { signal }); }
    catch (error) {
      if (error.status !== 404) throw error;
      return client.get("/auth/organization/list", undefined, { signal });
    }
  }

  async function workspaceId(given, signal) {
    if (given) return given;
    const workspaces = await listWorkspaces(signal);
    if (workspaces?.length === 1) return workspaces[0].id;
    if (!workspaces?.length) throw new Error("This Kaneo API key cannot see any workspace.");
    throw new Error(`Choose a workspaceId: ${workspaces.map((item) => `${item.name} (${item.id})`).join(", ")}.`);
  }

  async function task(ref, signal) {
    const value = String(ref || "").trim();
    if (!value) throw new Error("taskId is required.");
    return ticketPattern.test(value)
      ? client.get(`/task/by-ticket-id/${encodeURIComponent(value)}`, undefined, { signal })
      : client.get(`/task/${encodeURIComponent(value)}`, undefined, { signal });
  }

  async function columns(projectId, signal) {
    return client.get(`/column/${encodeURIComponent(projectId)}`, undefined, { signal });
  }

  async function attachLabel(current, { labelId, name, color }, signal) {
    let label;
    if (labelId) label = { id: labelId };
    else {
      const wanted = String(name || "").trim();
      if (!wanted) throw new Error("Give a labelId or a label name.");
      const labels = await client.get(`/label/workspace/${encodeURIComponent(current.workspaceId)}`, undefined, { signal });
      label = labels.find((item) => !item.taskId && item.name.toLowerCase() === wanted.toLowerCase())
        || await client.send("POST", "/label", { name: wanted, color: color || defaultLabelColor, workspaceId: current.workspaceId }, { signal });
    }
    return compactLabel(await client.send("PUT", `/label/${encodeURIComponent(label.id)}/task`, { taskId: current.id }, { signal }));
  }

  return {
    async kaneo_workspaces(_, { signal }) {
      const workspaces = await listWorkspaces(signal);
      return { workspaces: workspaces.map(({ id, name, slug, role }) => ({ id, name, slug, ...(role ? { role } : {}) })) };
    },
    async kaneo_projects(args, { signal }) {
      // Without a workspaceId, every visible workspace is listed so one call finds any project.
      const workspaces = args.workspaceId ? [{ id: args.workspaceId }] : await listWorkspaces(signal);
      const groups = await Promise.all(workspaces.map(async (workspace) => {
        const projects = await client.get("/project", { workspaceId: workspace.id, includeArchived: args.includeArchived ? "true" : undefined }, { signal });
        // Older releases leave columns out of the project list; read them per project.
        const statuses = await Promise.all(projects.map(async (project) => (project.columns?.length
          ? project.columns : await columns(project.id, signal).catch(() => [])).map((column) => column.slug || column.id)));
        return { workspaceId: workspace.id, ...(workspace.name ? { workspace: workspace.name } : {}), projects: projects.map((project, index) => ({
          id: project.id, name: project.name, slug: project.slug, ...(project.archivedAt ? { archived: true } : {}),
          statuses: statuses[index], statistics: project.statistics
        })) };
      }));
      return groups.length === 1 ? groups[0] : { workspaces: groups };
    },
    async kaneo_tasks(args, { signal }) {
      const board = await client.get(`/task/tasks/${encodeURIComponent(args.projectId)}`, {
        status: args.status, priority: args.priority, assigneeId: args.assigneeId, page: args.page, limit: args.limit || 50
      }, { signal });
      const data = board?.data || board;
      return {
        project: { id: data.id, name: data.name, slug: data.slug, workspaceId: data.workspaceId },
        columns: (data.columns || []).map((column) => ({ status: column.slug, name: column.name, final: column.isFinal || undefined,
          tasks: (column.tasks || []).map((item) => compactTask(item)) })),
        ...(data.plannedTasks?.length ? { planned: data.plannedTasks.map((item) => compactTask(item)) } : {}),
        ...(data.archivedTasks?.length ? { archivedCount: data.archivedTasks.length } : {}),
        pagination: board?.pagination ? { page: board.pagination.page, totalPages: board.pagination.totalPages, total: board.pagination.total } : undefined
      };
    },
    async kaneo_get_task(args, { signal }) {
      const current = await task(args.taskId, signal);
      const labels = await client.get(`/label/task/${encodeURIComponent(current.id)}`, undefined, { signal });
      return { task: { ...compactTask(current), description: current.description || "", workspaceId: current.workspaceId,
        labels: labels.map(compactLabel) } };
    },
    async kaneo_search(args, { signal }) {
      const result = await client.get("/search", { q: args.query, workspaceId: await workspaceId(args.workspaceId, signal),
        projectId: args.projectId, type: args.type || "all", limit: args.limit || 20 }, { signal });
      return { total: result.totalCount, results: (result.results || []).map((item) => Object.fromEntries(Object.entries({
        type: item.type, id: item.id, title: item.title, project: item.projectName, projectId: item.projectId,
        ticket: item.projectSlug && item.taskNumber ? `${item.projectSlug}-${item.taskNumber}` : undefined,
        status: item.status, priority: item.priority
      }).filter(([, value]) => value !== undefined && value !== null))) };
    },
    async kaneo_labels(args, { signal }) {
      if (args.taskId) {
        const current = await task(args.taskId, signal);
        return { taskId: current.id, labels: (await client.get(`/label/task/${encodeURIComponent(current.id)}`, undefined, { signal })).map(compactLabel) };
      }
      const workspace = await workspaceId(args.workspaceId, signal);
      const labels = await client.get(`/label/workspace/${encodeURIComponent(workspace)}`, undefined, { signal });
      return { workspaceId: workspace, labels: labels.filter((label) => !label.taskId).map(compactLabel) };
    },
    async kaneo_create_task(args, { signal }) {
      let status = args.status;
      if (!status) status = (await columns(args.projectId, signal))[0]?.slug;
      if (!status) throw new Error("This project has no columns to place a task in.");
      const created = await client.send("POST", `/task/${encodeURIComponent(args.projectId)}`, {
        title: args.title, description: args.description || "", priority: args.priority || "no-priority", status,
        ...(args.dueDate ? { dueDate: args.dueDate } : {}), ...(args.startDate ? { startDate: args.startDate } : {}),
        ...(args.assigneeId ? { userId: args.assigneeId } : {})
      }, { signal });
      const labels = [];
      if (args.labels?.length) {
        const current = await task(created.id, signal);
        for (const name of args.labels) labels.push(await attachLabel(current, { name }, signal));
      }
      return { task: { ...compactTask(created), ...(labels.length ? { labels: labels.map((label) => label.name) } : {}) } };
    },
    async kaneo_update_task(args, { signal }) {
      const current = await task(args.taskId, signal);
      const path = (field) => `/task/${field}/${encodeURIComponent(current.id)}`;
      const changes = [];
      let latest = current;
      const put = async (field, body) => { latest = await client.send("PUT", path(field), body, { signal }); changes.push(field); };
      if (args.title !== undefined) await put("title", { title: args.title });
      if (args.description !== undefined) await put("description", { description: args.description });
      if (args.status !== undefined) await put("status", { status: args.status });
      if (args.priority !== undefined) await put("priority", { priority: args.priority });
      if (args.dueDate !== undefined) await put("due-date", args.dueDate ? { dueDate: args.dueDate } : {});
      if (args.assigneeId !== undefined) await put("assignee", { userId: args.assigneeId || null });
      if (!changes.length) throw new Error("Give at least one field to change.");
      return { changed: changes, task: compactTask(latest) };
    },
    async kaneo_move_task(args, { signal }) {
      if (!args.projectId && !args.status) throw new Error("Give a destination projectId, status, or both.");
      const current = await task(args.taskId, signal);
      if (args.projectId && args.projectId !== current.projectId) {
        const moved = await client.send("PUT", `/task/move/${encodeURIComponent(current.id)}`, {
          destinationProjectId: args.projectId, ...(args.status ? { destinationStatus: args.status } : {})
        }, { signal });
        return { moved: "project", from: moved.sourceProjectId || current.projectId, task: compactTask(moved.task || moved) };
      }
      const updated = await client.send("PUT", `/task/status/${encodeURIComponent(current.id)}`, { status: args.status }, { signal });
      return { moved: "status", task: compactTask(updated) };
    },
    async kaneo_add_comment(args, { signal }) {
      const current = await task(args.taskId, signal);
      const comment = await client.send("POST", `/comment/${encodeURIComponent(current.id)}`, { content: args.content }, { signal });
      return { comment: { id: comment.id, taskId: current.id, createdAt: comment.createdAt } };
    },
    async kaneo_create_label(args, { signal }) {
      return { label: compactLabel(await client.send("POST", "/label", {
        name: args.name, color: args.color || defaultLabelColor, workspaceId: await workspaceId(args.workspaceId, signal) }, { signal })) };
    },
    async kaneo_update_label(args, { signal }) {
      if (args.name === undefined && args.color === undefined) throw new Error("Give a new name, color, or both.");
      const current = await client.get(`/label/${encodeURIComponent(args.labelId)}`, undefined, { signal });
      return { label: compactLabel(await client.send("PUT", `/label/${encodeURIComponent(current.id)}`, {
        name: args.name ?? current.name, color: args.color ?? current.color }, { signal })) };
    },
    async kaneo_delete_label(args, { signal }) {
      // Kaneo deletes large labels in batches: 202 means repeat until 200.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const { status, data } = await client.request("DELETE", `/label/${encodeURIComponent(args.labelId)}`, { signal });
        if (status !== 202) return { deleted: compactLabel(data || { id: args.labelId }) };
      }
      return { deleted: { id: args.labelId }, pending: true, note: "Kaneo is still removing this label from tasks; call again to finish." };
    },
    async kaneo_add_label(args, { signal }) {
      const current = await task(args.taskId, signal);
      return { taskId: current.id, label: await attachLabel(current, args, signal) };
    },
    async kaneo_remove_label(args, { signal }) {
      const current = await task(args.taskId, signal);
      const labels = await client.get(`/label/task/${encodeURIComponent(current.id)}`, undefined, { signal });
      let match = args.labelId ? labels.find((label) => label.id === args.labelId) : null;
      if (!match && args.labelId) {
        // A workspace label ID names the template; the task holds its own copy.
        const template = await client.get(`/label/${encodeURIComponent(args.labelId)}`, undefined, { signal });
        match = labels.find((label) => label.name === template.name);
      }
      if (!match && args.name) match = labels.find((label) => label.name.toLowerCase() === String(args.name).trim().toLowerCase());
      if (!match) throw new Error(`That label is not on this task. Its labels are: ${labels.map((label) => label.name).join(", ") || "none"}.`);
      await client.send("DELETE", `/label/${encodeURIComponent(match.id)}/task`, undefined, { signal });
      return { taskId: current.id, removed: match.name };
    }
  };
}

async function defaultInvoke(name, args, { signal }) {
  const client = new KaneoClient({ baseUrl: process.env.KANEO_BASE_URL, apiKey: await readKaneoKey() });
  const tools = createTools(client);
  if (!Object.hasOwn(tools, name)) throw new Error(`Unknown Kaneo tool: ${name}`);
  return tools[name](args || {}, { signal });
}

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

const activeRequests = new Map();
export async function handleMessage(message, invoke = defaultInvoke, requests = activeRequests) {
  if (message.method === "notifications/cancelled") {
    requests.get(message.params?.requestId)?.abort();
    return undefined;
  }
  if (message.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kaneo", version: "0.1.0" } };
  if (message.method === "tools/list") return { tools: availableTools() };
  if (message.method === "tools/call") {
    const controller = new AbortController();
    if (message.id !== undefined) {
      if (requests.has(message.id)) throw new Error("Duplicate active request ID.");
      requests.set(message.id, controller);
    }
    try {
      const data = await invoke(message.params?.name, message.params?.arguments || {}, { signal: controller.signal });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
    } finally { if (requests.get(message.id) === controller) requests.delete(message.id); }
  }
  if (message.method?.startsWith("notifications/")) return undefined;
  throw new Error(`Unsupported MCP method: ${message.method}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("close", () => { for (const controller of activeRequests.values()) controller.abort(); });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Malformed JSON-RPC message." } }); return; }
    try {
      const result = await handleMessage(message);
      if (message.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error?.message || String(error) } });
    }
  });
}
