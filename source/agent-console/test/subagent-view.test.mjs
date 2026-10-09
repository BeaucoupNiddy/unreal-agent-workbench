import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { elapsedFor, formatElapsed, groupSummary, isDelegateCommand, isSubagentUpdate, subagentFacts, upsertSubagent } from '../public/subagent-view.js';
import { groupTranscriptEntries } from '../public/activity.js';

const update = (state, extra = {}) => ({ sessionUpdate: 'tool_call_update', toolCallId: 'subagent-1', _meta: { 'unreal-agent/subagent': state }, ...extra });

test('subagent updates become one card entry that keeps its report', () => {
  const entries = [], byId = new Map();
  upsertSubagent(entries, byId, update({ name: 'Explorer', status: 'running', startedAt: 1000, steps: [] }));
  upsertSubagent(entries, byId, update({ status: 'completed', endedAt: 61_000 },
    { content: [{ type: 'content', content: { type: 'text', text: 'Found it.' } }] }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'subagent');
  assert.equal(entries[0].state.name, 'Explorer');
  assert.equal(entries[0].state.status, 'completed');
  assert.equal(entries[0].report, 'Found it.');
  assert.equal(elapsedFor(entries[0].state), '1m 00s');
  assert.ok(isSubagentUpdate(update({})));
  assert.ok(!isSubagentUpdate({ toolCallId: 'x' }));
});

test('facts, durations and group summaries read naturally', () => {
  assert.equal(formatElapsed(4_400), '4s');
  assert.equal(formatElapsed(3_725_000), '1h 02m');
  assert.deepEqual(subagentFacts({ stepCount: 1, inputTokens: 9000, outputTokens: 1400, cost: 0.004 }), ['1 step', '10k tokens', '$0.0040']);
  assert.deepEqual(subagentFacts({}), []);
  const card = (status) => ({ state: { status } });
  assert.equal(groupSummary([card('running'), card('running'), card('completed'), card('failed')]), '4 subagents · 2 running · 1 done · 1 failed');
});

test('the delegate command is replaced by its cards unless it failed, and parallel cards group together', () => {
  assert.ok(isDelegateCommand({ rawInput: { command: `unreal-capability delegate '{"agent":"explorer"}'` } }));
  assert.ok(!isDelegateCommand({ rawInput: { command: 'unreal-capability agents' } }));
  const tool = (id, status) => ({ type: 'tool', id, status, delegation: true });
  const card = (id) => ({ type: 'subagent', id, state: { status: 'running' } });
  const grouped = groupTranscriptEntries([
    { type: 'message', role: 'user', id: 'u' }, tool('b1', 'in_progress'), card('s1'), tool('b2', 'completed'), card('s2'),
    { type: 'message', role: 'agent', id: 'a' }, tool('b3', 'failed')
  ]);
  assert.deepEqual(grouped.map((entry) => entry.type), ['message', 'subagents', 'message', 'activity']);
  assert.deepEqual(grouped[1].entries.map((entry) => entry.id), ['s1', 's2']);
});

test('the transcript draws subagent groups and keeps timers ticking', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /isSubagentUpdate\(update\)\) \{\n    upsertSubagent\(state\.entries, state\.byTool, update\);/);
  assert.match(app, /entry\.type === "subagents"\) \{\n      const swarmId = entry\.swarm\?\.id;\n      ui\.messages\.append\(renderSubagentGroup/);
  assert.match(app, /swarm: \{ enabled: form\.elements\.swarmEnabled\.checked/);
  assert.match(app, /tickSubagentTimers\(ui\.messages\)/);
  assert.match(app, /delegation: Number\(form\.elements\.agentsDelegation\.value\)/);
});

test('agent messages before a turn\'s last one become compact progress notes', async () => {
  const message = (role, id) => ({ type: 'message', role, id, text: id });
  const card = { type: 'subagent', id: 's1', state: { status: 'completed' } };
  const grouped = groupTranscriptEntries([
    message('user', 'u1'), message('agent', 'a1'), card, message('agent', 'a2'), message('agent', 'a3'),
    message('user', 'u2'), message('agent', 'b1')
  ]);
  assert.deepEqual(grouped.filter((entry) => entry.type === 'message').map((entry) => [entry.id, Boolean(entry.interim)]),
    [['u1', false], ['a1', true], ['a2', true], ['a3', false], ['u2', false], ['b1', false]]);
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(entry\.interim\) \{[\s\S]*?\} else if \(entry\.text\) \{\n        const copy/);
});

test('a swarm becomes one group: its discussion header, then its member cards', async () => {
  const { swarmSummary } = await import('../public/subagent-view.js');
  const entries = [], byId = new Map();
  const swarmUpdate = (state) => ({ sessionUpdate: 'tool_call_update', toolCallId: 'swarm-1', _meta: { 'unreal-agent/swarm': state } });
  assert.ok(isSubagentUpdate(swarmUpdate({})));
  assert.ok(isDelegateCommand({ rawInput: { command: `unreal-capability swarm '{"task":"x"}'` } }));
  upsertSubagent(entries, byId, swarmUpdate({ swarmId: 's', task: 'Find the cause', status: 'running', messageCount: 0,
    members: [{ name: 'researcher-1', status: 'running' }, { name: 'researcher-2', status: 'running' }], messages: [] }));
  for (const name of ['researcher-1', 'researcher-2']) {
    upsertSubagent(entries, byId, { toolCallId: `subagent-${name}`, _meta: { 'unreal-agent/subagent': { name, status: 'running', swarmId: 's' } } });
  }
  upsertSubagent(entries, byId, { toolCallId: 'subagent-solo', _meta: { 'unreal-agent/subagent': { name: 'Explorer', status: 'running' } } });
  upsertSubagent(entries, byId, swarmUpdate({ status: 'completed', messageCount: 3,
    members: [{ name: 'researcher-1', status: 'completed' }, { name: 'researcher-2', status: 'completed' }] }));
  assert.equal(entries[0].type, 'swarm');
  const groups = groupTranscriptEntries(entries);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].swarm, entries[0]);
  assert.deepEqual(groups[0].entries.map((entry) => entry.state.name), ['researcher-1', 'researcher-2']);
  assert.deepEqual(groups[1].entries.map((entry) => entry.state.name), ['Explorer']);
  assert.equal(swarmSummary(entries[0].state), 'Swarm · 2 members · 3 messages · Done');
  assert.equal(swarmSummary({ status: 'running', messageCount: 1, members: [{ status: 'running' }, { status: 'completed' }] }), 'Swarm · 2 members · 1 message · 1 working');
});
