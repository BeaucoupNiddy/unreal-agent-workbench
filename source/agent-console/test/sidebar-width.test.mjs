import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { clampSidebarWidth, sidebarWidthLimit } from "../public/sidebar-width.js";

test("sidebar width respects desktop minimum, maximum, and workspace space", () => {
  assert.equal(clampSidebarWidth(120, 1400), 220);
  assert.equal(clampSidebarWidth(600, 1400), 560);
  assert.equal(clampSidebarWidth(500, 800), 480);
  assert.equal(sidebarWidthLimit(761), 441);
  assert.equal(clampSidebarWidth(302.4, 1400), 302);
});

test("sidebar resize hit area stays below overlapping header and popover controls", () => {
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const zIndex = (selector) => {
    const rule = css.split(`${selector} {`)[1]?.split("}")[0];
    return Number(rule?.match(/z-index:\s*(\d+)/)?.[1]);
  };
  const handle = zIndex(".sidebar-resize");
  assert.ok(handle > 0, "handle remains above ordinary layout surfaces");
  for (const selector of [".topbar", ".live-progress", ".control-popover", ".modal"]) {
    assert.ok(zIndex(selector) > handle, `${selector} must receive clicks before the resize handle`);
  }
});
