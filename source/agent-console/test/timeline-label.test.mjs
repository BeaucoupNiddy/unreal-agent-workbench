import assert from "node:assert/strict";
import test from "node:test";
import { timelineToolLabel } from "../public/timeline-label.js";

test("names observed tool calls by action rather than displaying truncated commands", () => {
  const cases = [
    ["View /tmp/screenshot.png", "Image"],
    ["cd ~/Projects/app && npm run check", "Tests"],
    ["npm install", "Install"],
    ["cd '/tmp/my app' && git status --short", "Git"],
    ["grep -Rin timeline public", "Search"],
    ["sed -n '1,100p' app.js", "Inspect"],
    ["python3 - <<'PY'", "Script"],
    ["curl --silent http://127.0.0.1:4318", "HTTP"],
    ["unreal-apply-patch < change.diff", "Edit"],
    ["npm run build", "Build"],
    ["unreal-capability call apple-productivity calendar_today '{}'", "Capability"],
    ["Archive", "Archive"],
    ["custom --unknown --flags", "Command"],
    ["", "Tool"]
  ];
  for (const [title, expected] of cases) assert.equal(timelineToolLabel(title), expected, title);
});

test("a search mentioning a test command is still a search", () => {
  assert.equal(timelineToolLabel("grep -R 'npm test' ."), "Search");
});

test("reasoning chart removes formatting marks without changing the stored summary", async () => {
  const { timelineReasoningText } = await import("../public/timeline-label.js");
  const raw = "**Adding token totals**\n## Checking layout";
  assert.equal(timelineReasoningText(raw), "Adding token totals\nChecking layout");
  assert.equal(raw, "**Adding token totals**\n## Checking layout");
});
