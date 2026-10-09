import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('mobile sidebar has no shadow that can bleed into the left edge when offscreen', () => {
  const rule = css.match(/\.sidebar \{[^}]*position: fixed;[^}]*\}/)?.[0];
  assert.ok(rule, 'mobile sidebar rule exists');
  assert.match(rule, /transform: translateX\(-10[01]%\)/);
  assert.match(rule, /box-shadow: none;/);
  assert.match(css, /\.sidebar\.open \{ transform: translateX\(0\); \}/);
});
