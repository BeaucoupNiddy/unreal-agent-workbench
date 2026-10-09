import test from 'node:test';
import assert from 'node:assert/strict';
import { createScrollFollow, nearBottom } from '../public/scroll-follow.js';

function pane() {
  const listeners = [];
  const element = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600,
    addEventListener: (_type, fn) => listeners.push(fn) };
  return { element, scroll(top) { element.scrollTop = top; listeners.forEach((fn) => fn()); } };
}

test('new output keeps the reader at the bottom only while they are there', () => {
  const { element, scroll } = pane();
  const changes = [];
  const follow = createScrollFollow(element, { onChange: (value) => changes.push(value), nextFrame: (fn) => fn() });
  assert.ok(nearBottom(element));
  element.scrollHeight = 1500;
  follow.afterRender(follow.beforeRender());
  assert.equal(element.scrollTop, 1500);
  // Scrolling up to read stops following; later output keeps their place.
  scroll(200);
  assert.equal(follow.following, false);
  const saved = follow.beforeRender();
  element.scrollTop = 0; element.scrollHeight = 2000; // re-render clamped the position
  follow.afterRender(saved);
  assert.equal(element.scrollTop, 200);
  // Returning to the bottom, or choosing Latest, follows again.
  scroll(1560);
  assert.equal(follow.following, true);
  scroll(100);
  follow.follow();
  assert.equal(follow.following, true);
  assert.equal(element.scrollTop, 2000);
  assert.deepEqual(changes, [false, true, false, true]);
});

test('the console uses it instead of always scrolling to the end', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /ui\.conversation\.scrollTop = ui\.conversation\.scrollHeight/);
  assert.match(app, /scrollFollow\.afterRender\(savedScroll\)/);
});
