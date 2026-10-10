import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BrowserManager, installedHeadlessShell, systemBrowserCandidates } from "../src/browser.mjs";
import { CapabilityBroker } from "../src/mcp.mjs";
import { readBrowserActivity } from "../src/browser-activity.mjs";

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ua-browser-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeExecutable(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "#!/bin/sh\n", { mode: 0o755 });
}

function fakePlaywright(launches, { fail = [] } = {}) {
  return async () => ({ chromium: { launch: async (options) => {
    launches.push(options.executablePath);
    if (fail.includes(options.executablePath)) throw new Error("cannot start\nmore detail");
    return { on() {}, close: async () => {}, newContext: async () => { throw new Error("not used"); } };
  } } });
}

test("lists Chromium-family browsers in system and user Applications", () => {
  const candidates = systemBrowserCandidates("/Users/someone");
  assert.ok(candidates.includes("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
  assert.ok(candidates.includes("/Users/someone/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"));
});

test("finds only a completely installed headless shell", async (t) => {
  const root = await temporary(t);
  const binary = path.join(root, "chromium_headless_shell-1243", "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
  await fakeExecutable(binary);
  assert.equal(await installedHeadlessShell(root), null);
  await fs.writeFile(path.join(root, "chromium_headless_shell-1243", "INSTALLATION_COMPLETE"), "");
  assert.equal(await installedHeadlessShell(root), binary);
});

test("uses an installed browser before downloading, and downloads only when none starts", async (t) => {
  const root = await temporary(t);
  const chrome = path.join(root, "Chrome", "chrome");
  await fakeExecutable(chrome);
  const launches = [];
  let installs = 0;
  const manager = new BrowserManager({ dataDir: root, candidates: [path.join(root, "missing"), chrome], loadPlaywright: fakePlaywright(launches),
    install: async () => { installs++; } });
  await manager.launchBrowser();
  assert.deepEqual(launches, [chrome]);
  assert.equal(installs, 0);

  const failing = [];
  const shell = path.join(root, "browsers", "chromium_headless_shell-1", "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
  const downloader = new BrowserManager({ dataDir: root, candidates: [chrome], loadPlaywright: fakePlaywright(failing, { fail: [chrome] }),
    install: async (notify) => {
      installs++;
      notify?.("downloading");
      await fakeExecutable(shell);
      await fs.writeFile(path.join(root, "browsers", "chromium_headless_shell-1", "INSTALLATION_COMPLETE"), "");
    } });
  const notes = [];
  await downloader.launchBrowser((text) => notes.push(text));
  assert.deepEqual(failing, [chrome, shell]);
  assert.equal(installs, 1);
  assert.deepEqual(notes, ["downloading"]);
});

test("rejects unknown actions, interaction in read-only mode, and unsupported URLs before starting a browser", async (t) => {
  const root = await temporary(t);
  const manager = new BrowserManager({ dataDir: root, candidates: [], loadPlaywright: async () => { throw new Error("should not start"); } });
  await assert.rejects(manager.run({ id: "one" }, { action: "teleport" }), /Unknown browser action/);
  await assert.rejects(manager.run({ id: "one", permissionMode: "read-only" }, { action: "click", ref: "e1" }), /Read-only mode allows looking/);
  await assert.rejects(manager.run({ id: "one", permissionMode: "read-only" }, { action: "eval", expression: "1" }), /Read-only mode/);
  assert.equal(await manager.run({ id: "one" }, { action: "close" }), "Browser closed for this chat.");
});

test("browser CLI sends JSON arguments, including from stdin, through the capability socket", async (t) => {
  const root = await temporary(t);
  const calls = [];
  const browser = { run: async (session, args) => { calls.push([session.id, args]); return `ran ${args.action}`; }, closeSession: async () => {}, close: async () => {} };
  const broker = new CapabilityBroker({ socketPath: path.join(root, "cli.sock"), sessions: new Map([["cli", { id: "cli" }]]), browser });
  t.after(() => broker.close());
  await broker.start();
  const cli = fileURLToPath(new URL("../bin/unreal-capability.mjs", import.meta.url));
  const env = { ...process.env, UNREAL_AGENT_CAPABILITY_SOCKET: broker.socketPath, UNREAL_AGENT_SESSION_ID: "cli" };
  const result = await promisify(execFile)(process.execPath, [cli, "browser", JSON.stringify({ action: "open", url: "http://localhost:1" })], { env });
  assert.equal(result.stdout.trim(), "ran open");
  const stdinResult = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, "browser"], { env }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify({ action: "snapshot" }));
  });
  assert.equal(stdinResult.trim(), "ran snapshot");
  assert.deepEqual(calls, [["cli", { action: "open", url: "http://localhost:1" }], ["cli", { action: "snapshot" }]]);
  await assert.rejects(promisify(execFile)(process.execPath, [cli, "browser", "[1]"], { env }), /JSON object/);
});

// Drives a real headless browser when one is already on this Mac. It never
// downloads one: the install hook fails instead.
async function availableBrowser() {
  if (process.env.UNREAL_AGENT_BROWSER) return true;
  for (const candidate of systemBrowserCandidates()) {
    if (await fs.access(candidate).then(() => true, () => false)) return true;
  }
  return false;
}

test("opens a local app, interacts by ref, and reports console errors, failed requests and screenshots", { skip: !(await availableBrowser()) && "no Chromium-family browser installed" }, async (t) => {
  const root = await temporary(t);
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>Demo app</title><h1>Sign up</h1>
        <label>Email <input id="email"></label><button id="go">Send</button><p id="out"></p>
        <script>
          console.warn("loaded");
          fetch("/missing.json");
          document.getElementById("go").onclick = () => {
            document.getElementById("out").textContent = "Thanks " + document.getElementById("email").value;
            console.error("clicked with " + document.getElementById("email").value);
          };
        </script>`);
    } else { response.statusCode = 404; response.end("nope"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const manager = new BrowserManager({ dataDir: root, install: async () => { throw new Error("tests never download a browser"); } });
  t.after(() => manager.close());
  const session = { id: "chat-1", permissionMode: "workspace-write" };

  const opened = await manager.run(session, { action: "open", url });
  assert.match(opened, /Title: Demo app/);
  assert.match(opened, /HTTP status: 200/);
  assert.match(opened, /heading "Sign up"/);
  const ref = opened.match(/button "Send" \[ref=(e\d+)\]/)?.[1];
  assert.ok(ref, opened);

  const typed = await manager.run(session, { action: "type", label: "Email", text: "pat@example.com", snapshot: false });
  assert.doesNotMatch(typed, /Page snapshot/);
  const clicked = await manager.run(session, { action: "click", ref });
  assert.match(clicked, /Thanks pat@example.com/);
  assert.match(clicked, /New since last check: .*console error.*failed request/);

  const consoleOutput = await manager.run(session, { action: "console" });
  assert.match(consoleOutput, /\[error\] clicked with pat@example.com/);
  assert.match(consoleOutput, /\[warning\] loaded/);
  const network = await manager.run(session, { action: "network" });
  assert.match(network, /GET .*\/missing\.json → 404/);
  assert.doesNotMatch(await manager.run(session, { action: "snapshot" }), /New since last check/);

  assert.equal(JSON.parse((await manager.run(session, { action: "eval", expression: "document.title" })).match(/Result: (.*)/)[1]), "Demo app");
  const shot = (await manager.run(session, { action: "screenshot", fullPage: true })).match(/Screenshot saved: (.*)/)[1];
  const bytes = await fs.readFile(shot);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.ok(shot.startsWith(path.join(root, "sessions", "browser", "chat-1")));

  // Every step is recorded for the console's Browser panel, with a live frame.
  const activity = await readBrowserActivity(path.join(root, "sessions", "browser", "chat-1"));
  assert.deepEqual(activity.entries.slice(0, 3).map((entry) => [entry.action, entry.ok]), [["open", true], ["type", true], ["click", true]]);
  assert.equal(activity.entries[0].status, 200);
  assert.equal(activity.entries[1].detail, "“Email” ← 15 characters");
  assert.ok(activity.entries.find((entry) => entry.action === "click").errors >= 1);
  assert.ok(activity.entries.some((entry) => entry.screenshot === path.basename(shot)));
  assert.equal(activity.agents[0].frame, "frame-main.jpg");
  const frame = await fs.readFile(path.join(root, "sessions", "browser", "chat-1", "frame-main.jpg"));
  assert.equal(frame[0], 0xff);
  await assert.rejects(manager.run(session, { action: "select", ref, values: ["x"] }));
  assert.equal((await readBrowserActivity(path.join(root, "sessions", "browser", "chat-1"), { after: activity.total })).entries[0].ok, false);

  // A subagent's steps appear in its parent chat under its own name.
  await manager.run({ id: "chat-1-sub-abc", parentId: "chat-1", agentLabel: "Tester", permissionMode: "read-only" }, { action: "open", url });
  const withSub = await readBrowserActivity(path.join(root, "sessions", "browser", "chat-1"));
  assert.ok(withSub.agents.some((agent) => agent.label === "Tester" && agent.url === url));
  await manager.closeSession("chat-1-sub-abc");

  // A second chat gets a clean context, and read-only chats can still look.
  const other = await manager.run({ id: "chat-2", permissionMode: "read-only" }, { action: "snapshot" });
  assert.match(other, /URL: about:blank/);
  await manager.closeSession("chat-2");
  assert.match(await manager.run(session, { action: "snapshot" }), /Thanks pat@example.com/);
});
