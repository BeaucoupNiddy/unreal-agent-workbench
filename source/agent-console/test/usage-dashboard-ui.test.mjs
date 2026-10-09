import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('settings exposes a separate dashboard tab with subscription and API cards', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="dashboardTab"[^>]*aria-controls="dashboardPanel"/);
  assert.match(html, /id="dashboardPanel"[^>]*role="tabpanel"/);
  assert.match(app, /dashboardSection\('Subscriptions · Claude & Codex'/);
  assert.match(app, /dashboardSection\('API use'/);
  assert.match(app, /requestJson\('\/api\/usage-dashboard'\)/);
});


test('subscription cost is never presented as an actual charge', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  // A plan chat's only actual charge is what its pay-per-use subagents reported.
  assert.match(app, /\['Actual charge', subscribed \? \(subagentCharge \? `Plan \+ \$\{subagentCharge\} API` : 'Included with plan'\)/);
  assert.match(app, /const subagentCharge = subagents\?\.apiResponses \? `\$\{formatCost\(subagents\.apiCost\)\}/);
});

test('dashboard breaks subagent usage down by subagent', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /'Subagents · all time'/);
  assert.match(app, /dashboardUsageTable\('Subagent', Object\.entries\(data\.agents\)/);
});


test('dashboard renders input, output and cached input as separate table columns', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(app, /tokenStat\('Input tokens · all time'/);
  assert.match(app, /tokenStat\('Output tokens · all time'/);
  assert.match(app, /tokenStat\('Cached input · all time'/);
  assert.match(app, /document\.createElement\('table'\)/);
  assert.match(app, /\[label, 'Total', 'Input', 'Output', 'Cached input', subscribed/);
  assert.match(app, /\['tokens', 'inputTokens', 'outputTokens', 'cachedReadTokens'\]/);
  assert.match(app, /dashboardUsageTable\(column, periods\.map/);
  assert.match(app, /dashboardUsageTable\('Model', data\.allTime\.models\.map/);
  assert.match(app, /td\.textContent = formatDashboardTokens\(count\)/);
  assert.match(css, /\.dashboard-table-wrap \{[^}]*overflow-x: auto/);
});

test('dashboard distinguishes foreground and background inference instead of hiding auxiliary work', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /Inference purpose · all time/);
  assert.match(app, /main: 'Chat responses', title: 'Generated titles', memory: 'Project memory'/);
  assert.match(app, /dashboardUsageTable\('Purpose', Object\.entries\(data\.purposes\)/);
});
