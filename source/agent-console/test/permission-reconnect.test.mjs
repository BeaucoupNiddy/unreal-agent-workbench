import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const classSource = source.slice(source.indexOf('class SessionBridge {'), source.indexOf('\nasync function createSession'));
function setup({ onAttach } = {}) {
  const timers = new Set(), bridges = new Map(), connections = [];
  class HydraConnection {
    closed = false; connects = 0; requests = []; responses = [];
    constructor() { connections.push(this); }
    async connect() { this.connects++; }
    async request(method, params) {
      if (method === 'session/attach' && this.requests.some(r => r.method === method)) throw new Error('client is already attached');
      this.requests.push({ method, params });
      if (method === 'session/attach') await onAttach?.(this, connections);
      return { configOptions: [] };
    }
    respond(id, result) { this.responses.push({ id, result }); }
    close() { this.closed = true; }
  }
  const timer = (fn) => { const t = { fn, unref() {} }; timers.add(t); return t; };
  class TurnHistory { async load() {} snapshot() { return []; } tool() {} }
  const context = { HydraConnection, TurnHistory, turnHistoryDir: "/unused", bridges, path, hydraDir: "/unused", autoTitles: {}, shouldGenerateAfterPrompt: () => false, recoverProvisionalTitle: async () => {}, readModelFavorites: async () => [],
    setInterval: timer, clearInterval: t => timers.delete(t), setTimeout: timer, clearTimeout: t => timers.delete(t) };
  const Bridge = vm.runInNewContext(`${classSource}\nSessionBridge`, context);
  const response = () => ({ destroyed: false, writableEnded: false, events: [],
    write(data) { assert.equal(this.writableEnded, false); this.events.push(data); },
    end() { this.writableEnded = true; } });
  const first = response(), bridge = new Bridge('chat', first); bridges.set('chat', bridge);
  return { bridge, bridges, first, response, timers, connections };
}
const approval = { id: 42, method: 'session/request_permission', params: { toolCall: { toolCallId: 'calendar-1', title: 'Use Calendar' }, options: [{ optionId: 'allow-once' }] } };

test('disconnect preserves approval client and replays pending approval on reconnect', async () => {
  const { bridge, first, response, bridges } = setup();
  await bridge.start(); first.destroyed = true; bridge.disconnect(first);
  assert.equal(bridge.connection.closed, false);
  assert.equal(bridges.get('chat'), bridge);
  bridge.connection.onRequest(approval);
  assert.equal(bridge.connection.responses.length, 0, 'never auto-approve');
  const next = response(); await bridge.reconnect(next);
  assert.equal(bridge.connection.connects, 1, 'same JSON-RPC connection');
  assert.ok(next.events.some(e => e.includes('event: permission') && e.includes('calendar-1')));
  assert.equal(bridge.permissionRequests.get('42'), 42);
  const timer = bridge.disconnectTimer; bridge.disconnect(first);
  assert.equal(bridge.disconnectTimer, timer, 'old close cannot disconnect new stream');
  bridge.stop();
});

test('disconnect expiry cancels rather than approves and releases connection', async () => {
  const { bridge, first, bridges, timers } = setup();
  await bridge.start(); bridge.connection.onRequest(approval);
  first.destroyed = true; bridge.disconnect(first); bridge.disconnectTimer.fn();
  assert.equal(bridge.connection.closed, true); assert.equal(bridges.size, 0);
  assert.equal(bridge.permissionRequests.size, 0); assert.equal(bridge.permissionPayloads.size, 0);
  assert.equal(bridge.connection.responses[0].result.outcome.outcome, 'cancelled');
  assert.equal(timers.size, 0);
});

test('approval resolved by another client is not replayed', async () => {
  const { bridge, response } = setup(); await bridge.start(); bridge.connection.onRequest(approval);
  bridge.connection.onNotification({ method: 'session/update', params: { update: { sessionUpdate: 'permission_resolved', toolCallId: 'calendar-1' } } });
  const next = response(); await bridge.reconnect(next);
  assert.ok(!next.events.some(e => e.includes('event: permission')));
  assert.equal(bridge.permissionRequests.size, 0); bridge.stop();
});

test('replayed permission cards are deduplicated', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('function addPermission('), app.indexOf('\nfunction escapeHtml('));
  const state = { entries: [] }; const context = { state, renderTranscript() {} };
  vm.runInNewContext(`${fn}\naddPermission({requestId: '42'}); addPermission({requestId: '42'});`, context);
  assert.equal(state.entries.length, 1);
});

function frames(response, type) {
  return response.events.filter(event => event.startsWith(`event: ${type}\n`));
}
function update(seq, text = 'chunk') {
  return { method: 'session/update', params: { _meta: { 'hydra-acp': { seq } },
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'message', content: { type: 'text', text } } } };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a long active prompt keeps its owner when every viewer leaves and uses no task deadline', async () => {
  const { bridge, first } = setup();
  await bridge.start();
  bridge.turnHistory = { turns: [], start() { const turn = { startedAt: Date.now() }; this.turns.push(turn); return turn; }, finish() {} };
  const gate = deferred();
  let deadline;
  bridge.connection.request = async (_, params, timeout) => { deadline = timeout; assert.equal(params._meta['unreal-agent/input-id'], 'stable-id'); return gate.promise; };
  const task = bridge.prompt('long task', [], 'stable-id');
  first.destroyed = true; bridge.disconnect(first);
  assert.equal(deadline, 0); assert.equal(bridge.connection.closed, false);
  assert.equal(bridge.disconnectTimer, null);
  gate.resolve({ stopReason: 'cancelled' }); await task;
  assert.ok(bridge.disconnectTimer); bridge.disconnectTimer.fn();
  assert.equal(bridge.connection.closed, true);
});

test('desktop and mobile remain connected and receive live updates without replaying desktop', async () => {
  const { bridge, first, response, connections, timers } = setup({ onAttach(connection, all) {
    if (connection !== all[0]) connection.onNotification(update(1, 'history'));
  } });
  await bridge.start();
  const before = first.events.length;
  const mobile = response(); await bridge.reconnect(mobile);
  assert.equal(first.writableEnded, false);
  assert.equal(first.events.length, before, 'joining viewer history and ready are private');
  assert.equal(frames(mobile, 'ready').length, 1);
  assert.equal(frames(mobile, 'hydra').length, 1);
  assert.equal(bridge.responses.size, 2);
  assert.equal(connections[0].closed, false);
  assert.equal(connections[1].closed, true, 'temporary replay client is released');
  bridge.connection.onNotification(update(2));
  assert.equal(frames(first, 'hydra').length, 1);
  assert.equal(frames(mobile, 'hydra').length, 2);
  assert.equal(timers.size, 1, 'one shared heartbeat, no disconnect timer');
  bridge.heartbeat.fn();
  assert.equal(first.events.at(-1), ': heartbeat\n\n');
  assert.equal(mobile.events.at(-1), ': heartbeat\n\n');
  bridge.stop();
  assert.equal(first.writableEnded, true); assert.equal(mobile.writableEnded, true);
});

test('disconnecting one viewer leaves the other live; grace period starts only after the last leaves', async () => {
  const { bridge, first, response, timers } = setup();
  await bridge.start(); const mobile = response(); await bridge.reconnect(mobile);
  mobile.destroyed = true; bridge.disconnect(mobile);
  assert.equal(bridge.disconnectTimer, null);
  assert.equal(timers.size, 1);
  bridge.connection.onNotification(update(2));
  assert.equal(frames(first, 'hydra').length, 1);
  first.destroyed = true; bridge.disconnect(first);
  assert.ok(bridge.disconnectTimer);
  assert.equal(bridge.heartbeat, null);
  const next = response(); await bridge.reconnect(next);
  assert.equal(bridge.disconnectTimer, null);
  assert.equal(timers.size, 1);
  bridge.stop();
});

test('approving on either device clears both cards and a second answer is rejected', async () => {
  const { bridge, first, response } = setup();
  await bridge.start(); const mobile = response(); await bridge.reconnect(mobile);
  bridge.connection.onRequest(approval);
  assert.equal(frames(first, 'permission').length, 1);
  assert.equal(frames(mobile, 'permission').length, 1);
  assert.equal(bridge.connection.responses.length, 0);
  assert.equal(bridge.answerPermission('42', 'allow-once'), true);
  assert.equal(bridge.answerPermission('42', 'allow-once'), false);
  assert.equal(bridge.connection.responses.length, 1);
  for (const viewer of [first, mobile]) {
    const event = JSON.parse(frames(viewer, 'console').at(-1).split('data: ')[1]);
    assert.equal(event.kind, 'permission_answered'); assert.equal(event.requestId, '42');
  }
  const next = response(); await bridge.reconnect(next);
  assert.equal(frames(next, 'permission').length, 0);
  bridge.stop();
});

test('overlapping replay and live chunks are delivered once, and unreplayed events are buffered', async () => {
  const { bridge, first, response } = setup({ onAttach(connection, all) {
    if (connection === all[0]) return;
    all[0].onNotification(update(10, 'overlap'));
    connection.onNotification(update(10, 'overlap'));
    all[0].onNotification(update(11, 'live-only'));
  } });
  await bridge.start(); const mobile = response(); await bridge.reconnect(mobile);
  assert.equal(frames(first, 'hydra').length, 2);
  assert.equal(frames(mobile, 'hydra').length, 2);
  assert.ok(frames(mobile, 'hydra')[0].includes('overlap'));
  assert.ok(frames(mobile, 'hydra')[1].includes('live-only'));
  assert.ok(mobile.events.at(-1).startsWith('event: ready'));
  bridge.stop();
});

test('joining while an approval is resolved cannot resurrect a stale card', async () => {
  const { bridge, response } = setup({ onAttach(connection, all) {
    if (connection === all[0]) return;
    all[0].onRequest(approval);
    bridge.answerPermission('42', 'allow-once');
  } });
  await bridge.start(); const mobile = response(); await bridge.reconnect(mobile);
  assert.equal(frames(mobile, 'permission').length, 0);
  bridge.stop();
});

test('two viewers joining during initial startup share a single persistent connection', async () => {
  const gate = deferred();
  const { bridge, first, response, connections } = setup({ async onAttach(connection, all) {
    if (connection === all[0]) await gate.promise;
  } });
  const starting = bridge.start(); const mobile = response(); const joining = bridge.reconnect(mobile);
  gate.resolve(); await Promise.all([starting, joining]);
  assert.equal(connections.length, 2);
  assert.equal(connections[0].requests.length, 1);
  assert.equal(first.writableEnded, false);
  assert.equal(frames(first, 'ready').length, 1);
  assert.equal(frames(mobile, 'ready').length, 1);
  bridge.stop();
});

test('a viewer leaving during replay cannot start a heartbeat or retain an abandoned response', async () => {
  const gate = deferred(), entered = deferred();
  const { bridge, first, response, timers } = setup({ async onAttach(connection, all) {
    if (connection !== all[0]) { entered.resolve(); await gate.promise; }
  } });
  await bridge.start(); const mobile = response(); const joining = bridge.reconnect(mobile);
  await entered.promise;
  mobile.destroyed = true; bridge.disconnect(mobile);
  gate.resolve(); await joining;
  assert.equal(bridge.responses.size, 1);
  assert.equal(frames(mobile, 'ready').length, 0);
  assert.equal(first.writableEnded, false);
  assert.equal(timers.size, 1);
  bridge.stop();
});

test('ready supplies the active prompt count to a viewer joining a running chat', async () => {
  const { bridge, response } = setup();
  await bridge.start(); bridge.activePrompts = 2;
  const mobile = response(); await bridge.reconnect(mobile);
  const ready = JSON.parse(frames(mobile, 'ready')[0].split('data: ')[1]);
  assert.equal(ready.activePrompts, 2);
  bridge.stop();
});

test('frontend removes an approval answered on another viewer by request ID', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('function handleConsole('), app.indexOf('\nfunction addPermission('));
  const state = { entries: [{ type: 'permission', requestId: '42' }, { type: 'message', text: 'keep' }, { type: 'permission', requestId: '43' }] };
  vm.runInNewContext(`${fn}\nhandleConsole({kind: 'permission_answered', requestId: '42'});`, { state, renderTranscript() {} });
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[0].type, 'message');
  assert.equal(state.entries[1].requestId, '43');
});


test('a replayed chunk arriving late on the owner socket is not appended twice on mobile', async () => {
  const { bridge, first, response } = setup({ onAttach(connection, all) {
    if (connection !== all[0]) connection.onNotification(update(10, 'replayed'));
  } });
  await bridge.start(); const mobile = response(); await bridge.reconnect(mobile);
  bridge.connection.onNotification(update(10, 'replayed'));
  bridge.connection.onNotification(update(11, 'new'));
  assert.equal(frames(first, 'hydra').length, 2);
  assert.equal(frames(mobile, 'hydra').length, 2);
  assert.ok(frames(mobile, 'hydra')[1].includes('new'));
  bridge.stop();
});

test('losing the first viewer during startup does not replay history twice to the second', async () => {
  const gate = deferred();
  const { bridge, first, response } = setup({ async onAttach(connection, all) {
    if (connection === all[0]) await gate.promise;
    connection.onNotification(update(10, 'history'));
  } });
  const starting = bridge.start(); const mobile = response(); const joining = bridge.reconnect(mobile);
  first.destroyed = true; bridge.disconnect(first);
  gate.resolve(); await Promise.all([starting, joining]);
  assert.equal(frames(mobile, 'hydra').length, 1);
  assert.equal(frames(mobile, 'ready').length, 1);
  bridge.stop();
});


const eventsRoute = source.slice(source.indexOf('      if (req.method === "GET" && action === "events") {'), source.indexOf('      if (req.method === "DELETE" && !action) {'));
async function openViewer(bridge, bridges, response) {
  response.writeHead = () => {};
  response.on = () => {};
  await vm.runInNewContext(`(async () => { ${eventsRoute} })()`, {
    req: { method: 'GET' }, action: 'events', sessionId: 'chat', bridges, res: response
  });
}

test('failed mobile replay reports only to mobile without stopping desktop or cancelling approval', async () => {
  const { bridge, bridges, first, response } = setup({ onAttach(connection, all) {
    if (connection !== all[0]) throw new Error('replay failed');
  } });
  await bridge.start(); bridge.connection.onRequest(approval);
  const mobile = response(); await openViewer(bridge, bridges, mobile);
  assert.equal(frames(mobile, 'fault').length, 1);
  assert.equal(mobile.writableEnded, true);
  assert.equal(frames(first, 'fault').length, 0);
  assert.equal(first.writableEnded, false);
  assert.equal(bridge.connection.closed, false);
  assert.equal(bridge.responses.size, 1);
  assert.equal(bridge.permissionRequests.size, 1);
  assert.equal(bridge.connection.responses.length, 0);
  assert.equal(bridges.get('chat'), bridge);
  bridge.stop();
});

test('multiple devices can replay simultaneously without sharing history or displacing viewers', async () => {
  const gate = deferred(), entered = deferred(); let replays = 0;
  const { bridge, first, response } = setup({ async onAttach(connection, all) {
    if (connection === all[0]) return;
    if (++replays === 2) entered.resolve();
    await gate.promise;
    connection.onNotification(update(10, 'history'));
  } });
  await bridge.start();
  const mobile = response(), tablet = response();
  const joining = [bridge.reconnect(mobile), bridge.reconnect(tablet)];
  await entered.promise; gate.resolve(); await Promise.all(joining);
  assert.equal(frames(first, 'hydra').length, 0);
  for (const viewer of [mobile, tablet]) {
    assert.equal(frames(viewer, 'hydra').length, 1);
    assert.equal(frames(viewer, 'ready').length, 1);
    assert.equal(viewer.writableEnded, false);
  }
  assert.equal(bridge.responses.size, 3);
  bridge.stop();
});

test('stopping a chat during replay closes every stream and cannot restart the heartbeat', async () => {
  const gate = deferred(), entered = deferred();
  const { bridge, first, response, timers, connections } = setup({ async onAttach(connection, all) {
    if (connection !== all[0]) { entered.resolve(); await gate.promise; }
  } });
  await bridge.start(); const mobile = response(); const joining = bridge.reconnect(mobile);
  await entered.promise; bridge.stop(); gate.resolve(); await joining;
  assert.equal(first.writableEnded, true); assert.equal(mobile.writableEnded, true);
  assert.equal(frames(mobile, 'ready').length, 0);
  assert.equal(bridge.responses.size, 0); assert.equal(timers.size, 0);
  assert.ok(connections.every(connection => connection.closed));
});
