import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('ui.composer.addEventListener("submit"'), source.indexOf('ui.stopTask.addEventListener'));
function setup(existing = false) {
  let resolve, submit;
  const state = { currentId: existing ? 'chat-1' : null, currentProjectPath: '/workspace', attachments: [], entries: [], byMessage: new Map(), promptRequests: 0, ready: false, configReady: new Promise(r => { resolve = r; }) };
  const calls = [], errors = [];
  const ui = { prompt: { value: 'Hello', style: {} }, composer: { addEventListener: (_, fn) => { submit = fn; } } };
  vm.runInNewContext(handler, { state, ui, updateSendAvailability() {}, renderAttachments() {}, renderTranscript() {},
    async startNewChat() { return state.currentId = 'chat-1'; },
    messageEntry(role, id) { const entry = { role, id }; state.entries.push(entry); return entry; },
    async requestJson(url, options) { calls.push({ url, body: JSON.parse(options.body) }); },
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
