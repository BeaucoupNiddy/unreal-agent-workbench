import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { folderApprovalReply } from '../public/folder-permissions.js';
import { recoverInputId, finishInputId } from '../public/input-recovery.js';
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('ui.composer.addEventListener("submit"'), source.indexOf('ui.stopTask.addEventListener'));
function setup(existing = false, result = { delivery: "sending" }) {
  let resolve, submit;
  const state = { currentId: existing ? 'chat-1' : null, currentProjectPath: '/workspace', attachments: [], entries: [], byMessage: new Map(), promptRequests: 0, ready: false, configReady: new Promise(r => { resolve = r; }) };
  const calls = [], errors = [];
  const ui = { prompt: { value: 'Hello', style: {} }, composer: { addEventListener: (_, fn) => { submit = fn; } } };
  vm.runInNewContext(handler, { crypto: webcrypto, folderApprovalReply, recoverInputId, finishInputId, state, ui, scrollFollow: { follow() {} }, updateSendAvailability() {}, renderAttachments() {}, renderTranscript() {}, renderTaskStatus() {},
    async startNewChat() { return state.currentId = 'chat-1'; },
    messageEntry(role, id) { const entry = { role, id }; state.entries.push(entry); return entry; },
    async requestJson(url, options) { calls.push({ url, body: JSON.parse(options.body) }); return result; },
    showToast(message) { errors.push(message); }
  });
  return { state, ui, calls, errors, submit: () => submit({ preventDefault() {} }),
    connect() { state.ready = true; resolve([]); }, fail() { resolve(null); } };
}
for (const existing of [false, true]) {
  test(`immediate send waits for connection (${existing ? 'selected' : 'new'} chat)`, async () => {
    const chat = setup(existing), pending = chat.submit();
    await Promise.resolve();
    assert.equal(chat.calls.length, 0);
    assert.equal(chat.ui.prompt.value, 'Hello');
    await chat.submit();
    chat.connect(); await pending;
    assert.equal(chat.calls.length, 1);
    assert.equal(chat.calls[0].url, '/api/sessions/chat-1/prompt');
    assert.equal(chat.calls[0].body.text, 'Hello');
    assert.equal(chat.state.submitting, false);
    assert.deepEqual(chat.errors, []);
  });
}
test('connection failure preserves text and attachments', async () => {
  const chat = setup();
  chat.state.attachments = [{ mimeType: 'image/png', data: 'YWJj' }];
  const pending = chat.submit(); chat.fail(); await pending;
  assert.equal(chat.calls.length, 0);
  assert.equal(chat.ui.prompt.value, 'Hello');
  assert.equal(chat.state.attachments.length, 1);
  assert.equal(chat.state.submitting, false);
  assert.equal(chat.errors.length, 1);
});
test('switching chats cannot send the pending message into another chat', async () => {
  const chat = setup(true), pending = chat.submit();
  chat.state.currentId = 'chat-2'; chat.ui.prompt.value = 'Other draft';
  chat.connect(); await pending;
  assert.equal(chat.calls.length, 0);
  assert.equal(chat.ui.prompt.value, 'Other draft');
});

test('Option+Return during an active task queues without adding an undelivered user bubble', async () => {
  const chat = setup(true, { delivery: 'queued' });
  chat.state.running = true; chat.state.promptRequests = 1; chat.state.queueNext = true;
  chat.state.attachments = [{ mimeType: 'image/png', data: 'YWJj' }];
  chat.connect(); await chat.submit();
  assert.equal(chat.calls.length, 1);
  assert.equal(chat.calls[0].body.delivery, 'queue');
  assert.equal(chat.calls[0].body.attachments[0].data, 'YWJj');
  assert.equal(chat.state.entries.length, 0);
  assert.equal(chat.state.running, true);
  assert.equal(chat.state.queueNext, false);
  assert.equal(chat.ui.prompt.value, '');
  assert.equal(chat.state.attachments.length, 0);
});
test('sending during an active task steers it and shows the message in place', async () => {
  const chat = setup(true, { delivery: 'steered' });
  chat.state.running = true; chat.state.promptRequests = 1;
  chat.connect(); await chat.submit();
  assert.equal(chat.calls[0].body.delivery, 'steer');
  assert.equal(chat.state.entries.length, 1);
  assert.equal(chat.state.entries[0].text, 'Hello');
  assert.equal(chat.state.entries[0].localPending, false);
  assert.equal(chat.state.running, true);
});
test('idle sends keep auto delivery', async () => {
  const chat = setup(true);
  chat.connect(); await chat.submit();
  assert.equal(chat.calls[0].body.delivery, 'auto');
});
test('an idle optimistic bubble is removed if the server queues because another client is working', async () => {
  const chat = setup(true, { delivery: 'queued' });
  chat.connect(); await chat.submit();
  assert.equal(chat.state.entries.length, 0);
  assert.equal(chat.state.submitting, false);
});

test('a setting response from a previous chat cannot overwrite the selected chat', async () => {
  const code = source.slice(source.indexOf('async function updateConfig('), source.indexOf('async function refresh()'));
  const state = { currentId: 'chat-1', configOptions: [{ id: 'model', currentValue: 'original' }] };
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const context = { state, requestJson: () => pending, applyConfigLabels() { throw new Error('stale render'); },
    renderUsageLabel() {}, closeControlPopover() {}, showToast() {} };
  vm.runInNewContext(`${code}\nthis.update = updateConfig;`, context);
  const update = context.update('model', 'changed');
  state.currentId = 'chat-2';
  resolve({ configOptions: [{ id: 'model', currentValue: 'changed' }] });
  await update;
  assert.equal(state.configOptions[0].currentValue, 'original');
});
