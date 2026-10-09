import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('ui.prompt.addEventListener("keydown"');
assert.notEqual(start, -1);
const handler = source.slice(start, source.indexOf('\n});', start) + 4);

function keydown({ touch, key = 'Enter', shiftKey = false, altKey = false, isComposing = false, running = false }) {
  let listener, submits = 0, prevented = false;
  const ui = {
    prompt: { addEventListener(type, callback) { assert.equal(type, 'keydown'); listener = callback; } },
    composer: { requestSubmit() { submits++; } }
  };
  const window = { matchMedia(query) { assert.equal(query, '(pointer: coarse)'); return { matches: touch }; } };
  const state = { running };
  vm.runInNewContext(handler, { ui, window, state });
  listener({ key, shiftKey, altKey, isComposing, preventDefault() { prevented = true; } });
  return { submits, prevented, queueNext: state.queueNext };
}

test('Return inserts a newline instead of sending on touch devices', () => {
  assert.deepEqual(keydown({ touch: true }), { submits: 0, prevented: false, queueNext: undefined });
});
test('desktop Return still sends, while Shift+Return and composition do not', () => {
  assert.deepEqual(keydown({ touch: false }), { submits: 1, prevented: true, queueNext: false });
  assert.deepEqual(keydown({ touch: false, shiftKey: true }), { submits: 0, prevented: false, queueNext: undefined });
  assert.deepEqual(keydown({ touch: false, isComposing: true }), { submits: 0, prevented: false, queueNext: undefined });
});
test('Option+Return queues behind a running task; plain Return steers it', () => {
  assert.equal(keydown({ touch: false, altKey: true, running: true }).queueNext, true);
  assert.equal(keydown({ touch: false, running: true }).queueNext, false);
  assert.equal(keydown({ touch: false, altKey: true }).queueNext, false, 'nothing to queue behind when idle');
});

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('hide keyboard is a non-submit button available on mobile', () => {
  assert.match(html, /<button[^>]*id="hideKeyboard"[^>]*type="button"[^>]*aria-label="Hide keyboard"/);
  assert.match(css, /\.hide-keyboard-button \{ display: none;/);
  assert.match(css, /@media \(pointer: coarse\), \(max-width: \d+px\) \{\s*\.hide-keyboard-button \{ display: inline-flex;/);
});

test('hide keyboard uses a small decorative icon with an accessible touch target', () => {
  const button = html.match(/<button[^>]*id="hideKeyboard"[^>]*>([\s\S]*?)<\/button>/)?.[1];
  assert.ok(button);
  assert.match(button, /<svg[^>]*width="20"[^>]*height="20"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(button, /Hide keyboard/);
  assert.match(css, /\.hide-keyboard-button \{[^}]*width: 44px; height: 44px;[^}]*border: 0;/);
});

test('keyboard visibility tracking is wired up and hidden state overrides mobile display', () => {
  assert.match(source, /setupKeyboardDismissal\(ui.prompt, \$\("#hideKeyboard"\)\);/);
  assert.match(html, /id="hideKeyboard"[^>]* hidden/);
  assert.match(css, /\.hide-keyboard-button\[hidden\] \{ display: none; \}/);
});
