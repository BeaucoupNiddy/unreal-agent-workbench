import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "../public/markdown.js";

test("renders inline markdown formatting and clickable links", () => {
  const html = renderMarkdown("# Update\n\nUse **bold**, *italic*, ~~removed~~, and `inline code`. See [the docs](https://example.com/guide?a=1&b=2 \"Reference\") or https://example.org/info.");
  assert.match(html, /<h1>Update<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<del>removed<\/del>/);
  assert.match(html, /<code>inline code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/guide\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer" title="Reference">the docs<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.org\/info" target="_blank" rel="noopener noreferrer">https:\/\/example\.org\/info<\/a>/);
});

test("renders emphasis when a closing marker is followed by whitespace or punctuation", () => {
  const html = renderMarkdown("*Published Unreal Agent 1.0.1* to GitHub. **Release notes** are ready; _thanks_ again. ~~Old~~ new. Keep * spaced * literal.");
  assert.match(html, /<em>Published Unreal Agent 1\.0\.1<\/em> to GitHub/);
  assert.match(html, /<strong>Release notes<\/strong> are ready/);
  assert.match(html, /<em>thanks<\/em> again/);
  assert.match(html, /<del>Old<\/del> new/);
  assert.match(html, /Keep \* spaced \* literal/);
});

test("renders common markdown blocks and fenced code", () => {
  const html = renderMarkdown("## Notes\n\n- first\n- **second**\n\n> A quoted line\n\n```js\nconst answer = '<safe>';\n```\n\n| Name | Value |\n| --- | ---: |\n| result | 42 |");
  assert.match(html, /<h2>Notes<\/h2>/);
  assert.match(html, /<ul><li>first<\/li><li><strong>second<\/strong><\/li><\/ul>/);
  assert.match(html, /<blockquote><p>A quoted line<\/p><\/blockquote>/);
  assert.match(html, /<pre><code class="language-js">const answer = &#39;&lt;safe&gt;&#39;;<\/code><\/pre>/);
  assert.match(html, /<table>/);
  assert.match(html, /style="text-align:right"/);
});

test("escapes raw HTML and does not allow unsafe link schemes", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> [bad](javascript:alert%281%29) [ok](https://safe.example)');
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /<p>.*bad.*<a href="https:\/\/safe\.example\/?"/);
});

test("nests ordered and unordered list items and preserves item continuations", () => {
  const html = renderMarkdown("- Parent item\n  continued here\n  - nested bullet\n  - second nested bullet\n- Next parent\n\n1. First step\n   1. Nested step\n   2. Another nested step\n2. Second step");
  assert.match(html, /<ul><li>Parent item continued here<ul><li>nested bullet<\/li><li>second nested bullet<\/li><\/ul><\/li><li>Next parent<\/li><\/ul>/);
  assert.match(html, /<ol><li>First step<ol><li>Nested step<\/li><li>Another nested step<\/li><\/ol><\/li><li>Second step<\/li><\/ol>/);
});
