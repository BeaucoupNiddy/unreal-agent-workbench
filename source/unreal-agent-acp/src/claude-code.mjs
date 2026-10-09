import { spawn } from 'node:child_process';
import { codexHome } from './codex-models.mjs';
import { statSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Claude Code owns its OAuth flow. The agent runtime never handles credentials.
// The console quota reader separately requests account-wide percentages from Anthropic.
export function claudeExecutable(env = process.env) {
  if (env.UNREAL_CLAUDE_COMMAND) return env.UNREAL_CLAUDE_COMMAND;
  return [path.join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
    .find((file) => { try { return statSync(file).isFile(); } catch { return false; } }) || 'claude';
}

export function claudeWritablePaths() {
  // Claude uses /tmp/claude-<uid> independently of macOS's per-user TMPDIR.
  // Seatbelt matches the canonical /private/tmp path, not the /tmp symlink.
  return [path.join(homedir(), '.claude'), path.join(homedir(), '.claude.json'),
    ...(process.platform === 'darwin' ? [`/private/tmp/claude-${process.getuid()}`] : [])];
}

// Print mode cannot show Claude's own approval prompts, so any tool needing one
// (including every Bash command) would be denied. Unreal's Seatbelt profile is
// the write boundary in Workspace; Full Access is approved by the user per chat.
export function claudeArgs(session, prompt) {
  return ['-p', Array.isArray(prompt) ? prompt.join('\n\n') : prompt,
    '--output-format', 'json', '--model', session.model,
    ...(session.claudeStarted ? ['--resume', session.id.slice('unreal-'.length)] : ['--session-id', session.id.slice('unreal-'.length)]),
    ...(session.permissionMode === 'read-only' ? ['--tools', ''] :
      ['--permission-mode', 'bypassPermissions'])];
}

// Claude may emit structured failure details on stdout even with a nonzero exit.
export function claudeResult(output, stderr, code) {
  let result;
  try { result = JSON.parse(output); } catch { /* Report stderr below if available. */ }
  if (code !== 0 || result?.is_error) {
    const details = [result?.result, ...(Array.isArray(result?.errors) ? result.errors : [])]
      .filter((value) => typeof value === 'string' && value.trim()).join('\n');
    throw new Error(details || stderr.trim() || `Claude Code exited with status ${code}.`);
  }
  if (!result || typeof result !== 'object') throw new Error('Claude Code returned an invalid response.');
  return result;
}

export async function claudeStatus(command = claudeExecutable()) {
  return new Promise((resolve) => {
    const child = spawn(command, ['auth', 'status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.on('data', (chunk) => { text = (text + chunk).slice(0, 10000); });
    child.on('error', () => resolve({ status: 'not-installed', message: 'Install Claude Code, then run claude login in Terminal.' }));
    child.on('close', (code) => {
      let result;
      try { result = JSON.parse(text); } catch { /* CLI versions can differ */ }
      resolve(code === 0 && result?.loggedIn === true
        ? { status: 'connected', message: 'Signed in to Claude Code.' }
        : { status: 'disconnected', message: 'Run claude login in Terminal to connect your Claude account.' });
    });
    setTimeout(() => { child.kill(); resolve({ status: 'unknown', message: 'Claude Code sign-in check timed out.' }); }, 4000).unref();
  });
}

// Only report presence of a compatible local Codex login; the pinned runner
// handles credentials itself and cannot refresh them. Never send auth data to UI.
export async function codexStatus(file = path.join(codexHome(), 'auth.json')) {
  try {
    const auth = JSON.parse(await fs.readFile(file, 'utf8'));
    return auth?.tokens?.access_token
      ? { status: 'connected', message: 'Codex login file found (not checked for expiry). Renew expired tokens with Codex.' }
      : { status: 'disconnected', message: 'Sign in with Codex in Terminal first (codex login).' };
  } catch { return { status: 'disconnected', message: 'Sign in with Codex in Terminal first (codex login).' }; }
}
