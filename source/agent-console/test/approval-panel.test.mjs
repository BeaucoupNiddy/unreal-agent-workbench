import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderApprovalPanel } from "../public/approval-panel.js";

class Element {
  children = []; listeners = {}; hidden = false; disabled = false;
  constructor(tag) { this.tag = tag; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(event, handler) { this.listeners[event] = handler; }
}
const doc = { createElement: tag => new Element(tag) };
const entry = { type: "permission", requestId: "42", request: {
  toolCall: { title: "Access requested folders", rawInput: { type: "folder-write-access", folders: ["/example"] } },
  options: [{ optionId: "allow-folders", name: "Allow" }, { optionId: "deny", name: "Deny" }]
} };

test("pending requests show their description, details, and exact approval choices", async () => {
  const panel = new Element("section"), answers = [];
  renderApprovalPanel(panel, [{ type: "tool" }, entry], async (...args) => answers.push(args), assert.fail, doc);
  assert.equal(panel.hidden, false);
  assert.equal(panel.children.length, 1);
  const card = panel.children[0];
  assert.equal(card.children[1].textContent, "Access requested folders");
  assert.match(card.children[2].children[1].textContent, /\/example/);
  const actions = card.children.at(-1);
  assert.deepEqual(actions.children.map(button => button.textContent), ["Allow", "Deny"]);
  assert.ok(actions.children.every(button => button.type === "button"));
  await actions.children[0].listeners.click();
  assert.deepEqual(answers, [[entry, "allow-folders"]]);
  renderApprovalPanel(panel, [], assert.fail, assert.fail, doc);
  assert.equal(panel.hidden, true);
  assert.equal(panel.children.length, 0);
});

test("approval disables all choices while sending and permits retry after failure", async () => {
  const panel = new Element("section"), errors = [];
  let reject;
  renderApprovalPanel(panel, [entry], () => new Promise((_, fail) => { reject = fail; }), error => errors.push(error), doc);
  const buttons = panel.children[0].children.at(-1).children;
  const sending = buttons[1].listeners.click();
  assert.ok(buttons.every(button => button.disabled));
  reject(new Error("Disconnected")); await sending;
  assert.deepEqual(errors, ["Disconnected"]);
  assert.ok(buttons.every(button => !button.disabled));
});

test("multiple pending requests remain accessible and missing options are not invented", () => {
  const panel = new Element("section");
  renderApprovalPanel(panel, [entry, { type: "permission", requestId: "43", request: { title: "Other request" } }], assert.fail, assert.fail, doc);
  assert.equal(panel.children.length, 2);
  const warning = panel.children[1].children.at(-1).children[0];
  assert.equal(warning.tag, "p");
  assert.match(warning.textContent, /No approval choices/);
});

test("approval choices live above the composer, outside the scrolling transcript", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /<footer class="composer-wrap">\s*<section id="approvalPanel"/);
  assert.match(app, /renderApprovalPanel\(\$\("#approvalPanel"\), state.entries, answerPermission, showToast\)/);
  assert.doesNotMatch(app, /else if \(entry.type === "permission"\)/);
});
