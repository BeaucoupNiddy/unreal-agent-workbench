import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('composer has compact bottom spacing even with the keyboard closed', () => {
  assert.match(css, /\.composer-area \{[^}]*padding: 10px 35px 4px;/);
  assert.match(css, /\.composer-area \{ padding: 8px 12px 4px; \}/);
});
