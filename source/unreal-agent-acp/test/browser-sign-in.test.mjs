import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { forgetSignIns, normalizeSignInUrl, readSignInState, runSignInWindow, signedInSites, signInStatePath, writeSignInState } from "../src/browser-sign-in.mjs";
import { BrowserManager, systemBrowserCandidates } from "../src/browser.mjs";

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ua-signin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const cookie = (name, domain, extra = {}) => ({ name, value: "v", domain, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax", ...extra });

test("sign-in addresses default to https, except local servers", () => {
  assert.equal(normalizeSignInUrl("kaneo.example.com"), "https://kaneo.example.com/");
  assert.equal(normalizeSignInUrl("localhost:5173/board"), "http://localhost:5173/board");
  assert.equal(normalizeSignInUrl("http://10.0.0.5:1337"), "http://10.0.0.5:1337/");
  assert.throws(() => normalizeSignInUrl(""), /Enter the address/);
  assert.throws(() => normalizeSignInUrl("file:///etc/passwd"), /http and https/);
});

test("saved sessions are private, listed by site without values, and can be forgotten per site", async (t) => {
  const root = await temporary(t);
  assert.deepEqual(await signedInSites(root), []);
  await writeSignInState(root, {
    cookies: [cookie("a", ".kaneo.example.com"), cookie("b", "kaneo.example.com"), cookie("old", "expired.test", { expires: 1 }), cookie("c", "github.com")],
    origins: [{ origin: "http://localhost:5173", localStorage: [{ name: "token", value: "x" }] }]
  });
  assert.equal((await fs.stat(signInStatePath(root))).mode & 0o777, 0o600);
  assert.deepEqual(await signedInSites(root), ["kaneo.example.com", "github.com", "localhost"]);
  await forgetSignIns(root, "kaneo.example.com");
  assert.deepEqual((await readSignInState(root)).cookies.map((item) => item.name), ["old", "c"]);
  await forgetSignIns(root);
  assert.equal(await readSignInState(root), null);
});

test("the sign-in window saves the session when the user closes its last page", async (t) => {
  const root = await temporary(t);
  const context = new EventEmitter(), page = new EventEmitter(), browser = new EventEmitter();
  const pages = [page];
  let visited = "", closed = false;
  Object.assign(page, { goto: async (url) => { visited = url; }, bringToFront: async () => {} });
  Object.assign(context, { pages: () => pages, newPage: async () => page, storageState: async () => ({ cookies: [cookie("session", "kaneo.example.com")], origins: [] }) });
  Object.assign(browser, { newContext: async () => context, close: async () => { closed = true; } });
  const chromium = { launch: async (options) => { assert.equal(options.headless, false); return browser; } };
  const done = runSignInWindow({ dataDir: root, url: "kaneo.example.com", chromium, executablePath: "/x" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  pages.length = 0;
  page.emit("close");
  await done;
  assert.equal(visited, "https://kaneo.example.com/");
  assert.equal(closed, true);
  assert.deepEqual(await signedInSites(root), ["kaneo.example.com"]);
});

async function availableBrowser() {
  for (const candidate of systemBrowserCandidates()) if (await fs.access(candidate).then(() => true, () => false)) return true;
  return Boolean(process.env.UNREAL_AGENT_BROWSER);
}

test("agent browsers start with saved sign-ins and pick up new ones and sign-outs mid-chat", { skip: !(await availableBrowser()) && "no Chromium-family browser installed" }, async (t) => {
  const root = await temporary(t);
  const server = http.createServer((request, response) => {
    const match = /(?:^|;\s*)user=([^;]+)/.exec(request.headers.cookie || "");
    response.setHeader("content-type", "text/html");
    response.end(`<title>Board</title><h1>${match ? `Signed in as ${match[1]}` : "Please sign in"}</h1>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const manager = new BrowserManager({ dataDir: root, install: async () => { throw new Error("tests never download a browser"); } });
  t.after(() => manager.close());
  const signedIn = (value) => ({ cookies: [cookie("user", "127.0.0.1", { value, httpOnly: false })], origins: [] });

  await writeSignInState(root, signedIn("pat"));
  assert.match(await manager.run({ id: "one" }, { action: "open", url }), /Signed in as pat/);

  assert.match(await manager.run({ id: "two" }, { action: "snapshot" }), /about:blank/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeSignInState(root, signedIn("sam"));
  assert.match(await manager.run({ id: "one" }, { action: "reload" }), /Signed in as sam/);

  await forgetSignIns(root);
  assert.match(await manager.run({ id: "one" }, { action: "reload" }), /Please sign in/);
});
