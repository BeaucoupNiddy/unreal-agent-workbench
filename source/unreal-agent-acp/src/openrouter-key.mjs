// The OpenRouter API key lives in the user's login keychain, never in a file.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const keychainService = "Unreal Agent OpenRouter";
export const legacyKeychainService = "Harness Chat OpenRouter";
const account = () => userInfo().username;
const defaultSecurity = (args) => execFileAsync("/usr/bin/security", args);

async function find(service, security) {
  const { stdout } = await security(["find-generic-password", "-a", account(), "-s", service, "-w"]);
  return stdout.trim();
}

export async function readOpenRouterKey({ security = defaultSecurity, env = process.env } = {}) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  try { return await find(keychainService, security); }
  catch {
    // Preserve the legacy item for rollback; keep using it if a copy is denied.
    try {
      const key = await find(legacyKeychainService, security);
      if (key) await security(["add-generic-password", "-a", account(), "-s", keychainService, "-w", key]).catch(() => {});
      return key;
    } catch { return ""; }
  }
}

export function validOpenRouterKey(value) {
  const key = String(value || "").trim();
  if (key.length < 24 || /\s/.test(key)) throw new Error("That OpenRouter key looks incomplete. Copy the whole key from openrouter.ai/keys.");
  return key;
}

// Checks the key with OpenRouter before saving. A network failure is not a rejection.
export async function verifyOpenRouterKey(key, { fetch = globalThis.fetch } = {}) {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 401 || response.status === 403) return { valid: false };
    return { valid: true, checked: response.ok };
  } catch { return { valid: true, checked: false }; }
}

export async function saveOpenRouterKey(value, { security = defaultSecurity } = {}) {
  const key = validOpenRouterKey(value);
  await security(["add-generic-password", "-U", "-a", account(), "-s", keychainService, "-w", key]);
  return key;
}

// Removes both the current and legacy items so the old copy cannot come back.
export async function clearOpenRouterKey({ security = defaultSecurity } = {}) {
  for (const service of [keychainService, legacyKeychainService]) {
    await security(["delete-generic-password", "-a", account(), "-s", service]).catch(() => {});
  }
}
