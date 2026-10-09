import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const handlerSource = source.slice(source.indexOf('const server = createServer('), source.indexOf('\nserver.listen('));
const inputId = '12345678-1234-4234-8234-123456789abc';
function setup() {
  let handler;
  const calls = [];
  const bridge = {
    acceptInput: async (...args) => { calls.push(['accept', ...args]); return { delivery: 'queued' }; },
    steerInput: async id => { calls.push(['steer', id]); return { delivery: 'sending' }; },
    removeQueuedInput: async id => { calls.push(['remove', id]); },
    cancelInputs: async () => { calls.push(['cancel']); }
  };
  vm.runInNewContext(handlerSource, { createServer: fn => { handler = fn; }, checkOrigin: () => true, URL,
    host: 'localhost', port: 8080, safeSessionId: id => id, bridges: new Map([['chat', bridge]]),
    readJson: async req => req.body, json: (res, status, body) => { res.status = status; res.body = body; } });
  return { calls, async post(action, body = {}) { const res = {}; await handler({ method: 'POST', url: `/api/sessions/chat/${action}`, headers: {}, body }, res); return res; } };
}
test('HTTP prompt accepts auto-queue delivery and responds with its durable ID', async () => {
  const api = setup();
  const result = await api.post('prompt', { text: 'follow-up', attachments: [], inputId });
  assert.equal(result.status, 202);
  assert.equal(result.body.delivery, 'queued'); assert.equal(result.body.inputId, inputId);
  assert.equal(api.calls[0][0], 'accept'); assert.equal(api.calls[0][4], 'auto');
});
test('Steer and remove endpoints are reachable through the session router', async () => {
  const api = setup();
  assert.equal((await api.post('steer', { inputId })).status, 202);
  assert.equal((await api.post('remove-queued', { inputId })).status, 200);
  assert.deepEqual(api.calls, [['steer', inputId], ['remove', inputId]]);
});
test('Stop uses the coordinated cancellation/queue-clearing path', async () => {
  const api = setup(); assert.equal((await api.post('cancel')).status, 202);
  assert.deepEqual(api.calls, [['cancel']]);
});
test('invalid delivery modes are rejected before saving input', async () => {
  const api = setup(); const result = await api.post('prompt', { text: 'follow-up', inputId, delivery: 'invalid' });
  assert.equal(result.status, 400); assert.deepEqual(api.calls, []);
});
