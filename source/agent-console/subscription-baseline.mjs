import { promises as fs } from 'node:fs';
import path from 'node:path';

const subscriptionProviders = new Set(['claude-code', 'openai-codex']);
const validId = (id) => /^hydra_session_[A-Za-z0-9_-]+$/.test(id || '');

// Save at session creation, before any prompt can be sent. Missing quota values
// remain missing; never backfill from later reads (which would misattribute usage).
export async function captureSubscriptionBaseline(folder, sessionId, provider, getUsage, origin = 'creation') {
  if (!validId(sessionId) || !subscriptionProviders.has(provider)) return null;
  const quota = await getUsage(provider, { force: true });
  const baseline = { provider, origin, capturedAt: new Date().toISOString(),
    short: quota.short, long: quota.long };
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${sessionId}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(baseline), { mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  return baseline;
}

export async function readSubscriptionBaseline(folder, sessionId) {
  if (!validId(sessionId)) return null;
  try {
    const value = JSON.parse(await fs.readFile(path.join(folder, `${sessionId}.json`), 'utf8'));
    return subscriptionProviders.has(value?.provider) ? value : null;
  } catch { return null; }
}

export async function deleteSubscriptionBaseline(folder, sessionId) {
  if (validId(sessionId)) await fs.rm(path.join(folder, `${sessionId}.json`), { force: true });
}
