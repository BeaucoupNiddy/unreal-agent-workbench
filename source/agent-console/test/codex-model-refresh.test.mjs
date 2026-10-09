import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { applyModelFavorites } from '../public/favorites.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const openPickerSource = source.slice(source.indexOf('async function openPicker('), source.indexOf('\nfunction openUsagePopover('));
function setup(provider = 'openai-codex') {
  let resolve, reject, draws = 0;
  const requests = [];
  const state = { currentId: 'chat-1', currentProvider: provider, modelFavorites: ['old'], configOptions: [
    { id: 'model', currentValue: 'old', options: [{ value: 'old', name: 'Old model' }] }
  ] };
  const element = () => ({ hidden: false, classList: { add() {} },
    append() {}, addEventListener() {}, setAttribute() {}, replaceChildren() { draws++; } });
  const popover = element();
  const context = { state, document: { createElement: element, createElementNS: element }, applyModelFavorites,
    config: (id) => state.configOptions.find(x => x.id === id),
    showControlPopover: (anchor) => { state.openControl = anchor.id; return popover; },
    applyConfigLabels() {}, requestJson: (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return new Promise((yes, no) => { resolve = yes; reject = no; });
    } };
  const openPicker = vm.runInNewContext(`${openPickerSource}\nopenPicker`, context);
  return { state, popover, requests, openPicker, draws: () => draws,
    resolve: (value) => resolve(value), reject: (error) => reject(error) };
}
const updated = { configOptions: [{ id: 'model', currentValue: 'old', options: [
  { value: 'old', name: 'Old model' }, { value: 'future', name: 'Future model' }
] }] };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Codex picker shows cached choices immediately and discovers new models without losing favorites', async () => {
  const f = setup();
  await f.openPicker('model', 'Model', 'MODEL', { id: 'modelButton' });
  assert.equal(f.draws(), 1);
  assert.deepEqual(f.requests, [{ url: '/api/sessions/chat-1/config', body: { configId: 'refresh_models', value: 'auto' } }]);
  f.resolve(updated); await flush();
  assert.equal(f.draws(), 2);
  const option = f.state.configOptions[0];
  assert.equal(option.currentValue, 'old');
  assert.ok(option.options.some(x => x.value === 'future'));
  assert.equal(option.options[0].favorite, true);
});

test('late discovery cannot overwrite a different chat after navigation', async () => {
  const f = setup();
  await f.openPicker('model', 'Model', 'MODEL', { id: 'modelButton' });
  f.state.currentId = 'chat-2';
  const before = f.state.configOptions;
  f.resolve(updated); await flush();
  assert.equal(f.state.configOptions, before);
  assert.equal(f.draws(), 1);
});

test('failed Codex discovery preserves the cached picker', async () => {
  const f = setup();
  await f.openPicker('model', 'Model', 'MODEL', { id: 'modelButton' });
  f.reject(new Error('Offline')); await flush();
  assert.equal(f.state.configOptions[0].options[0].value, 'old');
  assert.equal(f.draws(), 1);
});

test('other providers do not send Codex discovery requests', async () => {
  const f = setup('claude-code');
  await f.openPicker('model', 'Model', 'MODEL', { id: 'modelButton' });
  assert.equal(f.requests.length, 0);
});
