import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { imageUrl, mergeSteps, shouldAutoOpen, stepBadges, stepLabel } from "../public/browser-panel.js";

test("steps get readable labels and result chips", () => {
  assert.equal(stepLabel({ action: "eval" }), "Run script");
  assert.deepEqual(stepBadges({ ok: false, status: 404, errors: 2, failures: 1, screenshot: "screenshot-1.png" }).map((badge) => badge.text),
    ["Failed", "HTTP 404", "2 console errors", "1 failed request", "Screenshot"]);
  assert.deepEqual(stepBadges({ ok: true, status: 200 }), [{ kind: "ok", text: "HTTP 200" }]);
});

test("new steps are appended once, and a trimmed bridge log replaces the list", () => {
  const first = mergeSteps([], { entries: [{ seq: 1 }, { seq: 2 }] });
  assert.deepEqual(mergeSteps(first, { entries: [{ seq: 2 }, { seq: 3 }] }).map((step) => step.seq), [1, 2, 3]);
  assert.deepEqual(mergeSteps(first, { reset: true, entries: [{ seq: 1, fresh: true }] }), [{ seq: 1, fresh: true }]);
});

test("image URLs stay inside the chat's browser route", () => {
  assert.equal(imageUrl("hydra_session_a", "frame-main.jpg", "2026-10-09T10:00:00Z"),
    "/api/sessions/hydra_session_a/browser/image/frame-main.jpg?v=2026-10-09T10%3A00%3A00Z");
});

test("opens by itself only for new activity in a running chat the reader has not dismissed", () => {
  const base = { open: false, running: true, newSteps: 1, dismissed: false, narrow: false };
  assert.equal(shouldAutoOpen(base), true);
  for (const change of [{ open: true }, { running: false }, { newSteps: 0 }, { dismissed: true }, { narrow: true }]) {
    assert.equal(shouldAutoOpen({ ...base, ...change }), false, JSON.stringify(change));
  }
});

test("the page has the Browser button and side panel", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="browserButton"[^>]*aria-controls="browserPanel"/);
  for (const selector of ["browser-frame", "browser-steps", "browser-agent", "browser-close", "browser-live", "browser-address"]) {
    assert.match(html, new RegExp(`class="[^"]*${selector}`), selector);
  }
});

test("sign-in status explains an open window and shows errors", async () => {
  const { signInStatusText } = await import("../public/browser-panel.js");
  assert.match(signInStatusText({ open: true }).text, /close the window to save/);
  assert.deepEqual(signInStatusText({ error: "No browser" }), { text: "No browser", error: true });
  assert.equal(signInStatusText({}).text, "");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const selector of ["browser-signins", "browser-signin-list", "browser-signin-form", "browser-signin-url", "browser-signin-status"]) {
    assert.match(html, new RegExp(`class="[^"]*${selector}`), selector);
  }
});
