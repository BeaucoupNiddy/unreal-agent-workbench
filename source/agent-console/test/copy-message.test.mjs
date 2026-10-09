import assert from "node:assert/strict";
import test from "node:test";
import { copyMessage } from "../public/copy-message.js";

class FakeClipboardItem {
  constructor(data) { this.data = data; }
}

test("copies source Markdown and formatted HTML together", async () => {
  const source = "## Heading\n\n- **bold** [link](https://example.com)\n\n```js\nconst x = 1;\n```";
  let items;
  await copyMessage(source, { write: async (value) => { items = value; } }, FakeClipboardItem);
  assert.equal(await items[0].data["text/plain"].text(), source);
  const html = await items[0].data["text/html"].text();
  assert.match(html, /<h2>Heading<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com\/?"/);
  assert.match(html, /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);
});

test("falls back to Markdown when rich clipboard is unsupported or rejected", async () => {
  const written = [];
  const clipboard = {
    write: async () => { throw new Error("Rich paste unsupported"); },
    writeText: async (value) => { written.push(value); }
  };
  await copyMessage("**bold**", clipboard, FakeClipboardItem);
  await copyMessage("`code`", clipboard, null);
  assert.deepEqual(written, ["**bold**", "`code`"]);
  await assert.rejects(copyMessage("hello", { writeText: async () => { throw new Error("denied"); } }, null), /denied/);
});
