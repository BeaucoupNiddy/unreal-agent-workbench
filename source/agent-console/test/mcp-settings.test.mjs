import assert from "node:assert/strict";
import test from "node:test";
import { configuredMcpServers, normalizeMcpSettings } from "../mcp-settings.mjs";

test("Apple capabilities default on and retain explicit switches", () => {
  assert.deepEqual(normalizeMcpSettings({}), { appleNotes: true, appleCalendar: true });
  assert.deepEqual(normalizeMcpSettings({ appleNotes: false, appleCalendar: true }), {
    appleNotes: false,
    appleCalendar: true
  });
});

test("one lazy MCP server carries only enabled Apple capabilities", () => {
  assert.deepEqual(configuredMcpServers({ appleNotes: false, appleCalendar: false }, {
    nodePath: "/node", appleServerPath: "/apple/server.mjs"
  }), []);
  assert.deepEqual(configuredMcpServers({ appleNotes: true, appleCalendar: false }, {
    nodePath: "/node", appleServerPath: "/apple/server.mjs"
  }), [{
    name: "apple-productivity",
    command: "/node",
    args: ["/apple/server.mjs"],
    env: [{ name: "APPLE_MCP_CAPABILITIES", value: "notes" }]
  }]);
});
