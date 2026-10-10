// Isolated, manual-only static preview. Never imports or starts server.mjs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const port = Number(process.env.PORT || 4318);
const previewData = process.env.THEME_PREVIEW_FIXTURES === '1';
const fixture = Object.freeze({ projects: previewData ? [{ id: 'preview-project', name: 'Preview project', path: '/tmp/theme-preview' }] : [], removedProjectPaths: [], oneOffWorkspacePath: '', status: { ready: true }, sessions: previewData ? [{ id: 'preview-session', projectId: 'preview-project', title: 'Preview conversation', updatedAt: new Date().toISOString() }] : [], settings: { appleNotes: false, appleCalendar: false, kaneo: false }, generation: {}, agents: { enabled: false, subagents: [], maxConcurrent: 3 }, defaults: {}, catalog: { providers: [] }, tools: [] });
const send = (res, status, value, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(value) : value); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/')) {
    // All API writes terminate here and are intentionally discarded; no proxy/fallback exists.
    if (url.pathname === '/api/projects') return send(res, 200, { projects: fixture.projects, removedProjectPaths: [], oneOffWorkspacePath: '' });
    if (url.pathname === '/api/status') return send(res, 200, fixture.status);
    if (url.pathname === '/api/sessions') return send(res, 200, { sessions: fixture.sessions });
    if (url.pathname === '/api/capabilities') return send(res, 200, { settings: fixture.settings, kaneoKeySaved: false });
    if (url.pathname === '/api/generation-settings') return send(res, 200, { settings: fixture.generation, models: [] });
    if (url.pathname === '/api/default-model') return send(res, 200, { settings: fixture.defaults });
    if (url.pathname === '/api/models') return send(res, 200, fixture.catalog);
    if (url.pathname === '/api/agents') return send(res, 200, { settings: fixture.agents });
    if (url.pathname === '/api/tool-approvals') return send(res, 200, { tools: [] });
    if (url.pathname === '/api/openrouter-key') return send(res, 200, { configured: false });
    if (url.pathname === '/api/usage-dashboard') return send(res, 200, {});
    if (url.pathname === '/api/subscription-usage') return send(res, 200, {});
    if (url.pathname === '/api/activity') return send(res, 200, { events: [] });
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(root + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  try {
    const body = await readFile(target);
    const ext = path.extname(target);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { send(res, 404, 'Not found', 'text/plain'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Isolated theme preview: http://127.0.0.1:${port} (API writes are ephemeral/discarded)`));
