import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { installedWindowedChromium, readSignInState, runSignInWindow, signInVersion } from "./browser-sign-in.mjs";
import { appendBrowserActivity, browserActivityDirectory, browserActivityOwner, describeBrowserStep } from "./browser-activity.mjs";

// A headless Chromium driven by Playwright for agents that need to look at
// web pages: their own local apps, staging sites, or browser-only bugs. Each
// chat (and each subagent or swarm member) gets its own clean browser context;
// all of them share one browser process that closes when nobody uses it.

const require = createRequire(import.meta.url);
const maximumSnapshotCharacters = 9000;
const maximumOutputCharacters = 18000;
const maximumEvents = 200;
const actionTimeoutMs = 10_000;
const navigationTimeoutMs = 30_000;
const idleSessionMs = 15 * 60 * 1000;
const installTimeoutMs = 10 * 60 * 1000;

const readOnlyActions = new Set(["open", "snapshot", "screenshot", "console", "network", "wait", "scroll", "back", "forward", "reload", "tabs", "viewport", "close"]);
const pageChangingActions = new Set(["open", "click", "type", "press", "select", "hover", "wait", "back", "forward", "reload", "tabs", "scroll"]);
export const browserActions = [...new Set([...readOnlyActions, "click", "type", "press", "select", "hover", "eval"])];

export function systemBrowserCandidates(home = homedir()) {
  const apps = [
    ["Google Chrome", "Google Chrome"], ["Chromium", "Chromium"], ["Microsoft Edge", "Microsoft Edge"], ["Brave Browser", "Brave Browser"]
  ];
  return ["/Applications", path.join(home, "Applications")]
    .flatMap((folder) => apps.map(([app, binary]) => path.join(folder, `${app}.app`, "Contents", "MacOS", binary)));
}

async function executable(file) {
  return fs.access(file, constants.X_OK).then(() => true, () => false);
}

// Playwright's own headless shell, installed under `browsersPath`.
export async function installedHeadlessShell(browsersPath) {
  const entries = await fs.readdir(browsersPath).catch(() => []);
  for (const entry of entries.filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse()) {
    const root = path.join(browsersPath, entry);
    if (!await fs.stat(path.join(root, "INSTALLATION_COMPLETE")).then(() => true, () => false)) continue;
    const folders = await fs.readdir(root).catch(() => []);
    for (const folder of folders.filter((name) => name.startsWith("chrome-headless-shell"))) {
      const candidate = path.join(root, folder, "chrome-headless-shell");
      if (await executable(candidate)) return candidate;
    }
  }
  return null;
}

function truncate(text, maximum) {
  const value = String(text ?? "");
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n… (truncated; ${value.length - maximum} more characters)`;
}

function allowedUrl(value) {
  const text = String(value || "").trim();
  if (/^localhost(:\d+)?(\/|$)|^127\.0\.0\.1(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  let url;
  try { url = new URL(text); }
  catch { throw new Error("Browser open needs a full URL such as http://localhost:3000 or https://example.com."); }
  if (!["http:", "https:", "file:", "data:", "about:"].includes(url.protocol)) throw new Error(`The browser cannot open ${url.protocol} URLs.`);
  return url.toString();
}

function pushBounded(list, item) {
  list.push(item);
  if (list.length > maximumEvents) list.splice(0, list.length - maximumEvents);
}

export class BrowserManager {
  constructor({ dataDir, loadPlaywright, candidates, install, idleMs = idleSessionMs, browserIdleMs = 60_000 } = {}) {
    this.dataDir = dataDir;
    this.browsersPath = path.join(dataDir, "browsers");
    this.loadPlaywright = loadPlaywright || (() => import("playwright-core"));
    this.candidates = candidates || systemBrowserCandidates();
    this.installBrowser = install || ((notify) => this.installHeadlessShell(notify));
    this.idleMs = idleMs;
    this.browserIdleMs = browserIdleMs;
    this.browserTimer = null;
    this.browserPromise = null;
    this.browserName = "";
    this.sessions = new Map();
  }

  async installHeadlessShell(notify, { windowed = false } = {}) {
    await fs.mkdir(this.browsersPath, { recursive: true, mode: 0o700 });
    notify?.(windowed ? "Downloading Playwright's Chromium for the sign-in window (about 150 MB, one time)…"
      : "Downloading Playwright's headless Chromium for the first browser use (about 100 MB, one time)…");
    const cli = path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "install", ...(windowed ? [] : ["--only-shell"]), "chromium"], {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: this.browsersPath }, stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), installTimeoutMs);
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`The browser download did not finish${stderr.trim() ? `: ${stderr.trim()}` : "."} Check the internet connection and try again.`));
      });
    });
  }

  // Order: an explicit override, Playwright's own shell if already downloaded,
  // an installed Chromium-family browser (no download), then a one-time download.
  async launchBrowser(notify) {
    const { chromium } = await this.loadPlaywright();
    const options = { headless: true, args: ["--no-first-run", "--no-default-browser-check"] };
    const attempts = [];
    if (process.env.UNREAL_AGENT_BROWSER) attempts.push(process.env.UNREAL_AGENT_BROWSER);
    const shell = await installedHeadlessShell(this.browsersPath);
    if (shell) attempts.push(shell);
    for (const candidate of this.candidates) if (await executable(candidate)) attempts.push(candidate);
    const errors = [];
    for (const executablePath of attempts) {
      try {
        const browser = await chromium.launch({ ...options, executablePath, timeout: navigationTimeoutMs });
        this.browserName = path.basename(executablePath);
        return browser;
      } catch (error) { errors.push(`${path.basename(executablePath)}: ${String(error.message).split("\n")[0]}`); }
    }
    await this.installBrowser(notify);
    const downloaded = await installedHeadlessShell(this.browsersPath);
    if (!downloaded) throw new Error(`No usable browser was found${errors.length ? ` (${errors.join("; ")})` : ""}, and the download did not produce one.`);
    const browser = await chromium.launch({ ...options, executablePath: downloaded, timeout: navigationTimeoutMs });
    this.browserName = path.basename(downloaded);
    return browser;
  }

  // A visible window where the user signs in to sites for the agents. Only
  // one is open at a time; it resolves when the user closes it.
  openSignInWindow(url, { notify, onSaved } = {}) {
    if (this.signInPromise) throw new Error("A sign-in window is already open. Close it first.");
    const promise = (async () => {
      const { chromium } = await this.loadPlaywright();
      const attempts = [process.env.UNREAL_AGENT_BROWSER, ...this.candidates].filter(Boolean);
      let executablePath = null;
      for (const candidate of attempts) if (await executable(candidate)) { executablePath = candidate; break; }
      executablePath ||= await installedWindowedChromium(this.browsersPath);
      if (!executablePath) {
        await this.installHeadlessShell(notify, { windowed: true });
        executablePath = await installedWindowedChromium(this.browsersPath);
      }
      if (!executablePath) throw new Error("No browser that can show a window was found or downloaded.");
      await runSignInWindow({ dataDir: this.dataDir, url, chromium, executablePath, onSaved });
    })().finally(() => { if (this.signInPromise === promise) this.signInPromise = null; });
    this.signInPromise = promise;
    return promise;
  }

  get signInOpen() { return Boolean(this.signInPromise); }

  // Brings sign-ins saved after this context started into it (cookies only;
  // site storage arrives with the next new context).
  async syncSignIns(state) {
    const version = await signInVersion(this.dataDir);
    if (version === state.signIns) return;
    state.signIns = version;
    const saved = version ? await readSignInState(this.dataDir).catch(() => null) : null;
    if (saved?.cookies?.length) await state.context.addCookies(saved.cookies).catch(() => {});
    else if (!version) await state.context.clearCookies().catch(() => {});
  }

  browser(notify) {
    if (!this.browserPromise) {
      const promise = this.launchBrowser(notify).then((browser) => {
        browser.on("disconnected", () => {
          if (this.browserPromise === promise) this.browserPromise = null;
          this.sessions.clear();
        });
        return browser;
      });
      promise.catch(() => { if (this.browserPromise === promise) this.browserPromise = null; });
      this.browserPromise = promise;
    }
    return this.browserPromise;
  }

  watchPage(state, page) {
    if (state.pages.includes(page)) return;
    state.pages.push(page);
    page.on("console", (message) => {
      const location = message.location?.();
      pushBounded(state.console, { type: message.type(), text: truncate(message.text(), 1000),
        ...(location?.url ? { source: `${location.url}:${location.lineNumber ?? 0}` } : {}) });
      if (message.type() === "error") state.unseen.errors++;
    });
    page.on("pageerror", (error) => {
      pushBounded(state.console, { type: "pageerror", text: truncate(error?.stack || error?.message || error, 1500) });
      state.unseen.errors++;
    });
    page.on("requestfailed", (request) => {
      pushBounded(state.network, { method: request.method(), url: request.url(), failed: request.failure()?.errorText || "failed", resource: request.resourceType() });
      state.unseen.failures++;
    });
    page.on("response", (response) => {
      const request = response.request();
      const entry = { method: request.method(), url: response.url(), status: response.status(), resource: request.resourceType() };
      pushBounded(state.network, entry);
      if (entry.status >= 400) state.unseen.failures++;
    });
    page.on("dialog", (dialog) => {
      pushBounded(state.console, { type: "dialog", text: `${dialog.type()}: ${truncate(dialog.message(), 500)} (dismissed)` });
      dialog.dismiss().catch(() => {});
    });
    page.on("close", () => {
      state.pages = state.pages.filter((item) => item !== page);
      if (state.page === page) state.page = state.pages.at(-1) || null;
    });
  }

  async stateFor(session, notify) {
    let state = this.sessions.get(session.id);
    if (state?.context && !state.closed) return state;
    const browser = await this.browser(notify);
    const signIns = await signInVersion(this.dataDir);
    const saved = signIns ? await readSignInState(this.dataDir).catch(() => null) : null;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, ...(saved ? { storageState: saved } : {}) });
    context.setDefaultTimeout(actionTimeoutMs);
    context.setDefaultNavigationTimeout(navigationTimeoutMs);
    state = { context, page: null, pages: [], console: [], network: [], unseen: { errors: 0, failures: 0 }, queue: Promise.resolve(), screenshots: 0, timer: null, signIns };
    context.on("page", (page) => { this.watchPage(state, page); state.page = page; });
    this.sessions.set(session.id, state);
    state.page = await context.newPage();
    this.watchPage(state, state.page);
    return state;
  }

  touch(sessionId, state) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { void this.closeSession(sessionId); }, this.idleMs);
    state.timer.unref?.();
  }

  // For `type`, `text` is what to enter, so it never chooses the element.
  locator(page, args, { byText = true } = {}) {
    if (args.ref) return page.locator(`aria-ref=${String(args.ref).replace(/^\[?ref=/, "").replace(/\]$/, "")}`);
    if (args.selector) return page.locator(String(args.selector)).first();
    if (args.label) return page.getByLabel(String(args.label)).first();
    if (byText && args.text) return page.getByText(String(args.text), { exact: Boolean(args.exact) }).first();
    throw new Error(byText ? "Choose the element with `ref` (from the latest snapshot), `selector`, `text`, or `label`."
      : "Choose the field with `ref` (from the latest snapshot), `selector`, or `label`; `text` is what gets typed.");
  }

  async snapshot(page) {
    const text = await page.ariaSnapshot({ mode: "ai", timeout: actionTimeoutMs }).catch((error) => `(Snapshot unavailable: ${error.message.split("\n")[0]})`);
    return truncate(text, maximumSnapshotCharacters);
  }

  async run(session, args = {}, { notify } = {}) {
    const action = String(args.action || "").toLowerCase();
    if (!browserActions.includes(action)) throw new Error(`Unknown browser action "${args.action || ""}". Use one of: ${browserActions.join(", ")}.`);
    if (session.permissionMode === "read-only" && !readOnlyActions.has(action)) {
      throw new Error(`Read-only mode allows looking at pages but not ${action}. Change Permissions to Workspace to interact with pages.`);
    }
    if (action === "close") { await this.closeSession(session.id); return "Browser closed for this chat."; }
    const state = await this.stateFor(session, notify);
    const owner = browserActivityOwner(session);
    const step = { at: new Date().toISOString(), agent: owner.agent, agentKey: owner.agentKey, action, detail: describeBrowserStep(action, args), ok: true };
    const started = Date.now();
    const run = state.queue.then(() => this.syncSignIns(state)).then(() => this.perform(session, state, action, args, step)).then(
      async (output) => { await this.record(state, owner, step, started); return output; },
      async (error) => {
        Object.assign(step, { ok: false, error: String(error?.message || error).split("\n")[0].slice(0, 300) });
        await this.record(state, owner, step, started);
        throw error;
      });
    state.queue = run.catch(() => {});
    try { return truncate(await run, maximumOutputCharacters); }
    finally { this.touch(session.id, state); }
  }

  // Saves the step and a small frame of the page for Agent Console's Browser
  // panel. Recording problems never fail the agent's step.
  async record(state, owner, step, started) {
    try {
      const directory = browserActivityDirectory(this.dataDir, owner.chatId);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const page = state.page;
      if (page && !page.isClosed()) {
        step.url ||= page.url();
        const frame = `frame-${owner.agentKey}.jpg`;
        const captured = await page.screenshot({ path: path.join(directory, frame), type: "jpeg", quality: 55, timeout: 3000, animations: "disabled" })
          .then(() => true, () => false);
        if (captured) step.frame = frame;
      }
      step.ms = Date.now() - started;
      await appendBrowserActivity(directory, step);
    } catch {}
  }

  async perform(session, state, action, args, step = {}) {
    if (!state.page || state.page.isClosed()) { state.page = await state.context.newPage(); this.watchPage(state, state.page); }
    const page = state.page;
    const lines = [];
    let response;
    switch (action) {
      case "open": response = await page.goto(allowedUrl(args.url), { waitUntil: args.waitUntil || "load" }); break;
      case "back": response = await page.goBack({ waitUntil: "load" }); break;
      case "forward": response = await page.goForward({ waitUntil: "load" }); break;
      case "reload": response = await page.reload({ waitUntil: "load" }); break;
      case "click": {
        const target = this.locator(page, args);
        if (args.double) await target.dblclick({ button: args.button || "left" });
        else await target.click({ button: args.button || "left" });
        break;
      }
      case "hover": await this.locator(page, args).hover(); break;
      case "type": {
        const target = this.locator(page, args, { byText: false });
        if (args.append) await target.pressSequentially(String(args.text ?? ""));
        else await target.fill(String(args.text ?? ""));
        if (args.submit) await target.press("Enter");
        break;
      }
      case "press": {
        const key = String(args.key || "").trim();
        if (!key) throw new Error("Press needs a key, such as Enter, Escape, Tab, or Meta+A.");
        if (args.ref || args.selector || args.text || args.label) await this.locator(page, args).press(key);
        else await page.keyboard.press(key);
        break;
      }
      case "select": {
        const values = Array.isArray(args.values) ? args.values.map(String) : [String(args.value ?? args.values ?? "")];
        lines.push(`Selected: ${JSON.stringify(await this.locator(page, args).selectOption(values))}`);
        break;
      }
      case "wait": {
        if (args.text) await page.getByText(String(args.text)).first().waitFor({ state: args.gone ? "hidden" : "visible", timeout: navigationTimeoutMs });
        else if (args.selector) await page.locator(String(args.selector)).first().waitFor({ state: args.gone ? "hidden" : "visible", timeout: navigationTimeoutMs });
        else await page.waitForTimeout(Math.max(0, Math.min(10_000, Number(args.ms) || 1000)));
        break;
      }
      case "scroll": await page.mouse.wheel(0, Number(args.y ?? 700) || 0); await page.waitForTimeout(150); break;
      case "viewport": {
        const width = Math.max(320, Math.min(3840, Number(args.width) || 1280));
        const height = Math.max(320, Math.min(2400, Number(args.height) || 800));
        await page.setViewportSize({ width, height });
        lines.push(`Viewport: ${width}×${height}`);
        break;
      }
      case "tabs": {
        if (args.index !== undefined) {
          const selected = state.pages[Number(args.index)];
          if (!selected) throw new Error(`No tab ${args.index}.`);
          state.page = selected;
          await selected.bringToFront();
        }
        const titles = await Promise.all(state.pages.map(async (item) => item.title().catch(() => "")));
        lines.push("Tabs:", ...state.pages.map((item, index) => `${index}${item === state.page ? " (current)" : ""}: ${titles[index] || "(untitled)"} — ${item.url()}`));
        break;
      }
      case "screenshot": {
        const owner = browserActivityOwner(session);
        const directory = browserActivityDirectory(this.dataDir, owner.chatId);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `screenshot-${Date.now()}-${owner.agentKey}-${++state.screenshots}.png`);
        step.screenshot = path.basename(file);
        if (args.ref || args.selector || args.text || args.label) await this.locator(page, args).screenshot({ path: file });
        else await page.screenshot({ path: file, fullPage: Boolean(args.fullPage ?? args.full_page) });
        await fs.chmod(file, 0o600).catch(() => {});
        lines.push(`Screenshot saved: ${file}`, "Call ViewImage with this exact path to look at it.");
        break;
      }
      case "console": {
        const entries = args.all ? state.console : state.console.filter((entry) => ["error", "warning", "pageerror", "dialog"].includes(entry.type));
        lines.push(entries.length ? `Console (${args.all ? "all" : "errors and warnings"}, oldest first):` : `No ${args.all ? "" : "error or warning "}console messages yet.`,
          ...entries.slice(-60).map((entry) => `[${entry.type}] ${entry.text}${entry.source ? ` (${entry.source})` : ""}`));
        if (args.clear) state.console = [];
        state.unseen.errors = 0;
        break;
      }
      case "network": {
        const entries = args.all ? state.network : state.network.filter((entry) => entry.failed || entry.status >= 400);
        lines.push(entries.length ? `Network (${args.all ? "recent requests" : "failures and HTTP errors"}, oldest first):` : `No ${args.all ? "" : "failed "}requests yet.`,
          ...entries.slice(-80).map((entry) => `${entry.method} ${truncate(entry.url, 300)} → ${entry.failed ? `FAILED ${entry.failed}` : entry.status} [${entry.resource}]`));
        if (args.clear) state.network = [];
        state.unseen.failures = 0;
        break;
      }
      case "eval": {
        const expression = String(args.expression || args.script || "").trim();
        if (!expression) throw new Error("Eval needs a JavaScript `expression`, for example \"document.title\".");
        const value = await page.evaluate(expression);
        lines.push(`Result: ${truncate(JSON.stringify(value) ?? "undefined", 6000)}`);
        break;
      }
      case "snapshot": break;
    }
    const title = await page.title().catch(() => "");
    const header = [`URL: ${page.url()}`, ...(title ? [`Title: ${title}`] : []), ...(response ? [`HTTP status: ${response.status()}`] : [])];
    const unseen = [];
    if (state.unseen.errors && action !== "console") unseen.push(`${state.unseen.errors} console error${state.unseen.errors === 1 ? "" : "s"}`);
    if (state.unseen.failures && action !== "network") unseen.push(`${state.unseen.failures} failed request${state.unseen.failures === 1 ? "" : "s"}`);
    if (unseen.length) header.push(`New since last check: ${unseen.join(", ")} (see the console / network actions).`);
    Object.assign(step, { url: page.url(), title, ...(response ? { status: response.status() } : {}),
      errors: state.unseen.errors, failures: state.unseen.failures });
    const wantsSnapshot = action === "snapshot" || (pageChangingActions.has(action) && args.snapshot !== false);
    return [...header, ...lines, ...(wantsSnapshot ? ["Page snapshot (use [ref=…] values as `ref`):", await this.snapshot(page)] : [])].join("\n");
  }

  async closeSession(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    state.closed = true;
    clearTimeout(state.timer);
    await state.context?.close().catch(() => {});
    // Keep the shared browser briefly so the next chat or subagent starts fast.
    clearTimeout(this.browserTimer);
    this.browserTimer = setTimeout(() => {
      if (this.sessions.size || !this.browserPromise) return;
      const promise = this.browserPromise;
      this.browserPromise = null;
      promise.then((browser) => browser.close(), () => {}).catch(() => {});
    }, this.browserIdleMs);
    this.browserTimer.unref?.();
  }

  async close() {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
    clearTimeout(this.browserTimer);
    const promise = this.browserPromise;
    this.browserPromise = null;
    await promise?.then((browser) => browser.close(), () => {}).catch(() => {});
  }
}

export const browserInstruction = "A headless browser is built in for checking web pages and local apps (for example a dev server you started): `unreal-capability browser '{\"action\":\"open\",\"url\":\"http://localhost:3000\"}'`. Other actions: snapshot, click, type (text, submit), press (key), select (values), hover, wait (text|selector|ms), scroll, back, forward, reload, screenshot (fullPage; then ViewImage the returned path), console (all), network (all), eval (expression), tabs (index), viewport (width, height), close. Target elements with `ref` from the latest page snapshot, or `selector`/`text`/`label`. Page-changing steps return a fresh snapshot (pass \"snapshot\":false to skip) and report new console errors or failed requests. Use it to verify UI changes and reproduce browser-only bugs; use web-search/web-fetch for plain reading. It is signed in only to sites the user chose with Sign in in Agent Console's Browser panel. If a page needs a login, ask the user to sign in there; never ask for or enter the user's passwords or payment details. On signed-in sites, avoid irreversible actions (deleting, sending, purchasing, changing settings) the user did not ask for.";
