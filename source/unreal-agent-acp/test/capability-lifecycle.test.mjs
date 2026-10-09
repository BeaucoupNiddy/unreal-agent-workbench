import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityBroker, McpStdioClient } from '../src/mcp.mjs';
const allow = { outcome: { outcome: 'selected', optionId: 'allow-once' } };

test('read-only blocks writes and unknown tools before requesting approval or dispatching', async () => {
  const broker = new CapabilityBroker({ sessions: new Map() });
  let approvals = 0, calls = 0;
  const session = { id: 'one', permissionMode: 'read-only', activeClient: { request: async () => { approvals++; return allow; } } };
  broker.clientFor = () => ({ call: async () => { calls++; return 'read'; } });
  await assert.rejects(broker.invokeTool(session, { name: 'notes' }, { name: 'notes_create', annotations: { readOnlyHint: false } }, {}), /Read-only/);
  await assert.rejects(broker.invokeTool(session, { name: 'unknown' }, { name: 'tool' }, {}), /Read-only/);
  assert.equal(approvals, 0); assert.equal(calls, 0);
  assert.equal(await broker.invokeTool(session, { name: 'notes' }, { name: 'notes_search', annotations: { readOnlyHint: true } }, {}), 'read');
  assert.equal(calls, 1);
});

test('cancellation while an approval is pending prevents late dispatch', async () => {
  const broker = new CapabilityBroker({ sessions: new Map() });
  let approve;
  const session = { id: 'one', activeClient: { request: () => new Promise((resolve) => { approve = resolve; }) } };
  broker.clientFor = () => ({ call: async () => assert.fail('cancelled tool dispatched') });
  const pending = broker.invokeTool(session, { name: 'notes' }, { name: 'write' }, {});
  broker.cancelSession(session); approve(allow);
  await assert.rejects(pending, /cancelled while awaiting approval/);
});

test('an in-flight MCP request sends protocol cancellation, rejects promptly and ignores a late response', async () => {
  const client = new McpStdioClient({ name: 'test' }), writes = [];
  client.child = { stdin: { writable: true, write: (line) => writes.push(JSON.parse(line)) } };
  const controller = new AbortController();
  const result = client.request('tools/call', { name: 'write' }, { signal: controller.signal });
  const id = writes[0].id;
  controller.abort();
  await assert.rejects(result, /may still complete/);
  assert.equal(writes[1].method, 'notifications/cancelled');
  assert.equal(writes[1].params.requestId, id);
  client.consume(Buffer.from(JSON.stringify({ id, result: 'late' }) + '\n'));
  assert.equal(client.pending.size, 0);
});

test('named capability discovery avoids unrelated servers and retains a large schema on demand', async () => {
  const broker = new CapabilityBroker({ sessions: new Map() }), session = { id: 'one', mcpServers: [{ name: 'notes' }, { name: 'other' }] };
  broker.sessions.set(session.id, session);
  let otherStarted = false;
  const schema = { type: 'object', description: 'large'.repeat(1000) };
  broker.clientFor = (_, server) => ({ tools: async () => {
    if (server.name === 'other') otherStarted = true;
    return [{ name: 'notes_search', description: 'search notes', inputSchema: schema }];
  } });
  const listed = await broker.handle({ sessionId: 'one', action: 'list', query: 'notes search' });
  assert.equal(otherStarted, false); assert.equal(listed[0].schemaAvailable, true);
  const fetched = await broker.handle({ sessionId: 'one', action: 'schema', server: 'notes', tool: 'notes_search' });
  assert.deepEqual(fetched.inputSchema, schema);
});
