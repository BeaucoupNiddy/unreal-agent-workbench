import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const home = homedir();
const cache = new Map();
const windows = (short, long) => [short, long].map((window) => {
  const value = window?.used_percent ?? window?.utilization;
  const reset = window?.resets_at ?? window?.reset_at ?? window?.resetsAt;
  return { percent: typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null,
    resetsAt: typeof reset === 'number' ? new Date(reset * 1000).toISOString() : typeof reset === 'string' ? reset : null };
});

export function normalizeSubscriptionUsage(provider, data) {
  const [short, long] = provider === 'openai-codex'
    ? windows(data?.rate_limit?.primary_window ?? data?.rate_limit?.primary ?? data?.primary,
      data?.rate_limit?.secondary_window ?? data?.rate_limit?.secondary ?? data?.secondary)
    : windows(data?.five_hour, data?.seven_day);
  return { provider, short, long, available: short.percent !== null || long.percent !== null };
}

async function claudeToken() {
  let raw;
  try {
    ({ stdout: raw } = await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 3000, maxBuffer: 16384 }));
  } catch {
    try { raw = await fs.readFile(path.join(home, '.claude', '.credentials.json'), 'utf8'); } catch { return null; }
  }
  try { return JSON.parse(raw)?.claudeAiOauth?.accessToken || null; } catch { return null; }
}

async function credentials(provider) {
  if (provider === 'claude-code') {
    const token = await claudeToken();
    return token ? { url: 'https://api.anthropic.com/api/oauth/usage', headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' } } : null;
  }
  try {
    const auth = JSON.parse(await fs.readFile(path.join(home, '.codex', 'auth.json'), 'utf8'));
    const token = auth?.tokens?.access_token;
    if (!token) return null;
    return { url: 'https://chatgpt.com/backend-api/wham/usage', headers: { Authorization: `Bearer ${token}`, ...(auth.tokens.account_id ? { 'ChatGPT-Account-Id': auth.tokens.account_id } : {}) } };
  } catch { return null; }
}

// Credentials are used only in the local server request to the provider's fixed HTTPS origin.
// The browser receives percentages and reset times, never an OAuth token or account identifier.
export async function getSubscriptionUsage(provider, { getCredentials = credentials, fetch = globalThis.fetch, now = Date.now, force = false } = {}) {
  if (!['claude-code', 'openai-codex'].includes(provider)) throw new Error('Unsupported subscription provider.');
  const previous = cache.get(provider);
  if (!force && previous && now() - previous.time < 60_000) return previous.value;
  const empty = { provider, short: { percent: null, resetsAt: null }, long: { percent: null, resetsAt: null }, available: false };
  let value = empty;
  try {
    const auth = await getCredentials(provider);
    if (auth) {
      const response = await fetch(auth.url, { headers: { Accept: 'application/json', ...auth.headers }, signal: AbortSignal.timeout(4500), redirect: 'error' });
      if (response.ok) value = normalizeSubscriptionUsage(provider, await response.json());
    }
  } catch { /* Missing login, expired credentials, offline, or provider changed its response. */ }
  cache.set(provider, { time: now(), value });
  return value;
}
