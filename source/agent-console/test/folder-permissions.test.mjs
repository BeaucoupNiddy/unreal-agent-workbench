import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { folderApprovalReply } from '../public/folder-permissions.js';
const entry = { type: 'permission', requestId: 'folders-1', request: { toolCall: {
  rawInput: { type: 'folder-write-access', folders: ['~/.docker/buildx', '~/Library/Application Support/Ochsner Kaneo'] }
}, options: [{ optionId: 'allow-folders' }, { optionId: 'reject' }] } };

test('explicit reply approves only a single pending folder card', () => {
  for (const text of ['ok', 'OK, you can do this, please move on', 'yes continue', 'Allow these folders!']) {
    assert.equal(folderApprovalReply([entry], text), entry);
  }
  for (const text of ['not ok', 'ok but do not write', 'ok delete everything', 'can I grant access?', 'please move on']) {
    assert.equal(folderApprovalReply([entry], text), null);
  }
  assert.equal(folderApprovalReply([], 'ok'), null);
  assert.equal(folderApprovalReply([entry, entry], 'ok'), null);
  assert.equal(folderApprovalReply([entry], 'ok', [{}]), null);
  assert.equal(folderApprovalReply([{ ...entry, request: { toolCall: { rawInput: {} } } }], 'ok'), null);
});

test('composer sends approval instead of queuing text; errors retain the draft', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('ui.composer.addEventListener("submit",'), source.indexOf('ui.stopTask.addEventListener("click",'));
  async function run(fail = false) {
    let submit;
    const calls = [], state = { entries: [entry], currentId: 'chat', ready: true, configReady: Promise.resolve({}),
      attachments: [], submitting: false, creatingChat: false, running: true, promptRequests: 1 };
    const ui = { prompt: { value: 'OK, you can do this, please move on', style: {} }, composer: { addEventListener: (_event, fn) => { submit = fn; } } };
    const context = { state, ui, folderApprovalReply, renderTaskStatus() {}, updateSendAvailability() {}, renderTranscript() {},
      renderAttachments() {}, showToast() {}, requestJson: async (url, args) => { calls.push({ url, body: JSON.parse(args.body) }); if (fail) throw new Error('approval failed'); } };
    vm.runInNewContext(handler, context);
    await submit({ preventDefault() {} });
    return { state, ui, calls };
  }
  const success = await run();
  assert.deepEqual(success.calls, [{ url: '/api/sessions/chat/permission', body: { requestId: 'folders-1', optionId: 'allow-folders' } }]);
  assert.equal(success.state.entries.length, 0); assert.equal(success.ui.prompt.value, '');
  const failed = await run(true);
  assert.equal(failed.state.entries.length, 1); assert.equal(failed.ui.prompt.value, 'OK, you can do this, please move on');
  assert.equal(failed.state.submitting, false);
});
