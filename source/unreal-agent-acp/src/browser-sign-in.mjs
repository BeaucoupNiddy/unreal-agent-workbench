import { constants, promises as fs } from "node:fs";
import path from "node:path";

// Sites the user signed in to for the agents' browser. The user signs in
// themselves in a visible browser window; the resulting cookies and site
// storage (Playwright's storage state) are saved privately and loaded into
// every agent browser context. The user's own Chrome profile is never read.

const saveIntervalMs = 2000;
const maximumWindowMs = 30 * 60 * 1000;

export function signInStatePath(dataDir) {
  return path.join(dataDir, "browser-sign-ins.json");
}

export async function readSignInState(dataDir) {
  try {
    const value = JSON.parse(await fs.readFile(signInStatePath(dataDir), "utf8"));
    return { cookies: Array.isArray(value?.cookies) ? value.cookies : [], origins: Array.isArray(value?.origins) ? value.origins : [] };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function signInVersion(dataDir) {
  const stat = await fs.stat(signInStatePath(dataDir)).catch(() => null);
  return stat ? `${stat.mtimeMs}:${stat.size}` : "";
}

export async function writeSignInState(dataDir, state) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = signInStatePath(dataDir);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ cookies: state.cookies || [], origins: state.origins || [] }), { mode: 0o600 });
  await fs.rename(temporary, file);
}

function siteOf(value) {
  return String(value || "").replace(/^\./, "").replace(/^https?:\/\//, "").replace(/[:/].*$/, "").toLowerCase();
}

// Sites with saved cookies or storage, most cookies first. Values are never returned.
export async function signedInSites(dataDir) {
  const state = await readSignInState(dataDir);
  if (!state) return [];
  const counts = new Map();
  for (const cookie of state.cookies) {
    if (cookie.expires > 0 && cookie.expires * 1000 < Date.now()) continue;
    const site = siteOf(cookie.domain);
    if (site) counts.set(site, (counts.get(site) || 0) + 1);
  }
  for (const origin of state.origins) {
    const site = siteOf(origin.origin);
    if (site && !counts.has(site)) counts.set(site, 0);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([site]) => site);
}

export async function forgetSignIns(dataDir, site) {
  if (!site) { await fs.rm(signInStatePath(dataDir), { force: true }); return; }
  const state = await readSignInState(dataDir);
  if (!state) return;
  const target = siteOf(site);
  const matches = (value) => { const candidate = siteOf(value); return candidate === target || candidate.endsWith(`.${target}`); };
  await writeSignInState(dataDir, {
    cookies: state.cookies.filter((cookie) => !matches(cookie.domain)),
    origins: state.origins.filter((origin) => !matches(origin.origin))
  });
}

async function executable(file) {
  return fs.access(file, constants.X_OK).then(() => true, () => false);
}

// Playwright's full (windowed) Chromium, if it was downloaded.
export async function installedWindowedChromium(browsersPath) {
  const entries = await fs.readdir(browsersPath).catch(() => []);
  for (const entry of entries.filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
    const root = path.join(browsersPath, entry);
    if (!await fs.stat(path.join(root, "INSTALLATION_COMPLETE")).then(() => true, () => false)) continue;
    for (const folder of await fs.readdir(root).catch(() => [])) {
      for (const app of (await fs.readdir(path.join(root, folder)).catch(() => [])).filter((name) => name.endsWith(".app"))) {
        const macos = path.join(root, folder, app, "Contents", "MacOS");
        for (const binary of await fs.readdir(macos).catch(() => [])) {
          if (await executable(path.join(macos, binary))) return path.join(macos, binary);
        }
      }
    }
  }
  return null;
}

export function normalizeSignInUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Enter the address of the site to sign in to.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(text) ? "http" : "https"}://${text}`;
  const url = new URL(withScheme);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Sign in works with http and https sites only.");
  return url.toString();
}

// Opens a visible browser at `url` for the user to sign in, saving the session
// every few seconds and when the user closes the window. Resolves when done.
export async function runSignInWindow({ dataDir, url, chromium, executablePath, onSaved, maximumMs = maximumWindowMs }) {
  const browser = await chromium.launch({ headless: false, executablePath, args: ["--no-first-run", "--no-default-browser-check"] });
  let finished = false;
  try {
    const existing = await readSignInState(dataDir);
    const context = await browser.newContext({ viewport: null, acceptDownloads: false, ...(existing ? { storageState: existing } : {}) });
    const save = async () => {
      if (finished) return;
      const state = await context.storageState().catch(() => null);
      if (state && !finished) { await writeSignInState(dataDir, state); onSaved?.(); }
    };
    const page = await context.newPage();
    await page.goto(normalizeSignInUrl(url)).catch(() => {});
    await page.bringToFront().catch(() => {});
    await new Promise((resolve) => {
      const timer = setInterval(() => { void save(); }, saveIntervalMs);
      const deadline = setTimeout(done, maximumMs);
      function done() { clearInterval(timer); clearTimeout(deadline); resolve(); }
      browser.on("disconnected", done);
      const watch = (item) => item.on("close", () => setTimeout(async () => {
        if (context.pages().length) return;
        await save();
        done();
      }, 100));
      context.pages().forEach(watch);
      context.on("page", watch);
    });
    await save();
  } finally {
    finished = true;
    await browser.close().catch(() => {});
  }
}
