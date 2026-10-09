import test from 'node:test';
import assert from 'node:assert/strict';
import { setupKeyboardDismissal } from '../public/keyboard-dismissal.js';

function target(properties = {}) {
  const listeners = new Map();
  return Object.assign(properties, {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    emit(type, event = {}) { for (const callback of listeners.get(type) || []) callback(event); }
  });
}

function setup({ visualViewport = true } = {}) {
  const viewport = target({ height: 800, scale: 1 });
  const win = target({ innerHeight: 800, innerWidth: 390, visualViewport: visualViewport ? viewport : undefined });
  const doc = { activeElement: null, documentElement: { clientHeight: 800, dataset: {} } };
  const prompt = target({ value: 'Unsent draft\nwith a new line', blur() { doc.activeElement = null; prompt.emit('blur'); } });
  const button = target({ hidden: false });
  setupKeyboardDismissal(prompt, button, win, doc);
  const focus = () => { doc.activeElement = prompt; prompt.emit('focus'); };
  const resize = (height) => { viewport.height = height; viewport.emit('resize'); };
  return { viewport, win, doc, prompt, button, focus, resize };
}

test('icon appears only after the focused prompt has an open keyboard', () => {
  const f = setup();
  assert.equal(f.button.hidden, true);
  f.focus();
  assert.equal(f.button.hidden, true, 'focus with a hardware keyboard is not enough');
  f.resize(750);
  assert.equal(f.button.hidden, true, 'browser toolbar-sized changes are ignored');
  f.resize(480);
  assert.equal(f.button.hidden, false);
  f.resize(800);
  assert.equal(f.button.hidden, true, 'native dismissal hides icon even if focus remains');
});

test('viewport shrink without chat focus and pinch zoom do not show the icon', () => {
  const f = setup();
  f.resize(480);
  assert.equal(f.button.hidden, true);
  f.focus();
  f.viewport.scale = 1.5;
  f.viewport.emit('resize');
  assert.equal(f.button.hidden, true);
  f.viewport.scale = 1;
  f.viewport.emit('resize');
  assert.equal(f.button.hidden, false);
  f.prompt.blur();
  assert.equal(f.button.hidden, true);
});

test('tap preserves focus until click, then dismisses without changing the draft', () => {
  const f = setup();
  f.focus();
  f.resize(480);
  let prevented = false;
  f.button.emit('pointerdown', { button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.doc.activeElement, f.prompt);
  assert.equal(f.button.hidden, false);
  f.button.emit('click');
  assert.equal(f.doc.activeElement, null);
  assert.equal(f.button.hidden, true);
  assert.equal(f.prompt.value, 'Unsent draft\nwith a new line');
});

test('orientation change resets the baseline and allows a landscape keyboard', () => {
  const f = setup();
  f.focus();
  f.resize(480);
  f.win.innerWidth = 844;
  f.win.innerHeight = f.doc.documentElement.clientHeight = 390;
  f.resize(390);
  assert.equal(f.button.hidden, true);
  f.resize(230);
  assert.equal(f.button.hidden, false);
});

test('layout-resizing browsers work without VisualViewport', () => {
  const f = setup({ visualViewport: false });
  f.focus();
  assert.equal(f.button.hidden, true);
  f.win.innerHeight = f.doc.documentElement.clientHeight = 480;
  f.win.emit('resize');
  assert.equal(f.button.hidden, false);
  f.win.innerHeight = f.doc.documentElement.clientHeight = 800;
  f.win.emit('resize');
  assert.equal(f.button.hidden, true);
});

test('keyboard spacing state follows opening, native dismissal, blur, and zoom', () => {
  const f = setup();
  const state = () => f.doc.documentElement.dataset.keyboardOpen;
  assert.equal(state(), 'false');
  f.focus();
  f.resize(750);
  assert.equal(state(), 'false', 'toolbar changes retain safe-area padding');
  f.resize(480);
  assert.equal(state(), 'true', 'an open keyboard uses compact padding');
  f.resize(800);
  assert.equal(state(), 'false', 'native dismissal restores safe-area padding');
  f.resize(480);
  assert.equal(state(), 'true');
  f.viewport.scale = 1.5;
  f.viewport.emit('resize');
  assert.equal(state(), 'false', 'pinch zoom is not a keyboard');
  f.viewport.scale = 1;
  f.viewport.emit('resize');
  assert.equal(state(), 'true');
  f.prompt.blur();
  assert.equal(state(), 'false', 'leaving the prompt restores resting padding');
});
