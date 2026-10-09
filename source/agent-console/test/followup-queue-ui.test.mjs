import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('function renderQueuedInputs()'), source.indexOf('function renderTranscript()'));
function setup(running = true) {
  const node = () => ({ children: [], listeners: {}, append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
    setAttribute(name, value) { this[name] = value; }, addEventListener(name, listener) { this.listeners[name] = listener; } });
  const panel = node(), calls = [], errors = [];
  const state = { currentId: 'chat', running, queuedInputs: [{ inputId: 'stable-id', text: '<script>not markup</script>', attachments: [{ data: 'YWJj' }] }] };
  const context = { state, ui: { followupQueue: panel }, document: { createElement: node }, showToast: error => errors.push(error),
    requestJson: async (url, options) => calls.push({ url, body: JSON.parse(options.body) }) };
  const render = vm.runInNewContext(`${renderSource}\nrenderQueuedInputs`, context);
  render();
  return { state, panel, calls, errors, render };
}
test('queued text stays text, attachment count is shown, and Steer uses the durable ID', async () => {
  const { panel, calls } = setup();
  const card = panel.children[1];
  assert.equal(card.children[0].textContent, '<script>not markup</script> · 1 image');
  const button = card.children[1].children[0];
  assert.equal(button.textContent, 'Steer now');
  await button.listeners.click();
  // The listener deliberately does not block rendering; request itself is synchronous up to its await.
  assert.equal(calls[0].url, '/api/sessions/chat/steer');
  assert.equal(calls[0].body.inputId, 'stable-id');
});
test('paused queues offer Send now; removing an item calls the removal route', async () => {
  const { panel, calls } = setup(false);
  const buttons = panel.children[1].children[1].children;
  assert.equal(buttons[0].textContent, 'Send now');
  await buttons[1].listeners.click();
  assert.equal(calls[0].url, '/api/sessions/chat/remove-queued');
});
test('empty queue hides the panel', () => {
  const { state, panel, render } = setup();
  state.queuedInputs = []; render();
  assert.equal(panel.hidden, true);
  assert.equal(panel.children.length, 0);
});
