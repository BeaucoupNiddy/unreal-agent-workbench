// Kaneo (https://kaneo.app) connection: instance URL in settings, API key in
// the user's login keychain, never in a file or in chat session metadata.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const kaneoKeychainService = "Unreal Agent Kaneo";
const account = () => userInfo().username;
const defaultSecurity = (args) => execFileAsync("/usr/bin/security", args);

// Accepts the address people copy from the browser (cloud or self-hosted) and
// returns the API base, which Kaneo serves under /api.
export function normalizeKaneoUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); }
  catch { throw new Error("Enter the Kaneo address, such as https://cloud.kaneo.app or your own server."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Enter an http or https Kaneo address without a user name or password.");
  }
  url.search = ""; url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/api$/i.test(pathname) ? pathname : `${pathname}/api`;
  return url.toString().replace(/\/+$/, "");
}

export async function readKaneoKey({ security = defaultSecurity, env = process.env } = {}) {
  if (env.KANEO_API_KEY) return env.KANEO_API_KEY.trim();
  try {
    const { stdout } = await security(["find-generic-password", "-a", account(), "-s", kaneoKeychainService, "-w"]);
    return stdout.trim();
  } catch { return ""; }
}

export function validKaneoKey(value) {
  const key = String(value || "").trim();
  if (key.length < 16 || /\s/.test(key)) throw new Error("That Kaneo API key looks incomplete. Copy the whole key from Kaneo's Settings > Account > Developer.");
  return key;
}

export async function saveKaneoKey(value, { security = defaultSecurity } = {}) {
  const key = validKaneoKey(value);
  await security(["add-generic-password", "-U", "-a", account(), "-s", kaneoKeychainService, "-w", key]);
  return key;
}

export async function clearKaneoKey({ security = defaultSecurity } = {}) {
  await security(["delete-generic-password", "-a", account(), "-s", kaneoKeychainService]).catch(() => {});
}

export class KaneoError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class KaneoClient {
  constructor({ baseUrl, apiKey, fetch = globalThis.fetch, timeoutMs = 20_000 }) {
    this.baseUrl = normalizeKaneoUrl(baseUrl);
    this.apiKey = apiKey;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  async request(method, pathname, { query, body, signal } = {}) {
    if (!this.baseUrl) throw new KaneoError("Kaneo is not set up. Add the Kaneo address in Settings > Capabilities.");
    if (!this.apiKey) throw new KaneoError("No Kaneo API key is saved. Add one in Settings > Capabilities.");
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [name, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    }
    const signals = [AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])];
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals)
      });
    } catch (error) {
      if (signal?.aborted) throw new KaneoError("The Kaneo request was cancelled. A change Kaneo already accepted may still apply.");
      throw new KaneoError(`Could not reach Kaneo at ${this.baseUrl} (${error?.cause?.code || error.message}).`);
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (response.ok) return { status: response.status, data };
    const detail = typeof data === "object" && data ? data.message || data.error : String(data || "").slice(0, 200);
    if (response.status === 401) throw new KaneoError("Kaneo rejected the API key. Create a new key in Kaneo and save it in Settings > Capabilities.", 401);
    if (response.status === 403) throw new KaneoError(`Kaneo denied access${detail ? `: ${detail}` : "."}`, 403);
    if (response.status === 404) throw new KaneoError(`Kaneo could not find that item${detail ? `: ${detail}` : "."}`, 404);
    throw new KaneoError(`Kaneo returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`, response.status);
  }

  async get(pathname, query, options) { return (await this.request("GET", pathname, { ...options, query })).data; }
  async send(method, pathname, body, options) { return (await this.request(method, pathname, { ...options, body })).data; }
}

// Checks a key before saving it. A network failure is not a rejection.
export async function verifyKaneoKey(baseUrl, apiKey, { fetch = globalThis.fetch } = {}) {
  try {
    const user = await new KaneoClient({ baseUrl, apiKey, fetch, timeoutMs: 10_000 }).get("/user/me");
    return { valid: true, checked: true, user: user?.name || user?.email || "" };
  } catch (error) {
    if (error.status === 401 || error.status === 403) return { valid: false, checked: true };
    return { valid: true, checked: false, error: error.message };
  }
}
