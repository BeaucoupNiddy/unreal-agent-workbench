import assert from "node:assert/strict";
import test from "node:test";
import { configuredMcpServers, normalizeMcpSettings } from "../mcp-settings.mjs";

test("Apple capabilities default on and retain explicit switches", () => {
  assert.deepEqual(normalizeMcpSettings({}), { appleNotes: true, appleCalendar: true, kaneo: false, kaneoUrl: "" });
  assert.deepEqual(normalizeMcpSettings({ appleNotes: false, appleCalendar: true }), {
    appleNotes: false,
    appleCalendar: true,
    kaneo: false,
    kaneoUrl: ""
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

test("Kaneo addresses normalize to the API base and invalid ones are dropped", () => {
  assert.equal(normalizeMcpSettings({ kaneoUrl: "https://cloud.kaneo.app/" }).kaneoUrl, "https://cloud.kaneo.app/api");
  assert.equal(normalizeMcpSettings({ kaneoUrl: "kaneo.example.com/api/" }).kaneoUrl, "https://kaneo.example.com/api");
  assert.equal(normalizeMcpSettings({ kaneoUrl: "http://192.168.1.5:1337" }).kaneoUrl, "http://192.168.1.5:1337/api");
  assert.equal(normalizeMcpSettings({ kaneoUrl: "ftp://nope" }).kaneoUrl, "");
});

test("Kaneo gets its own server carrying the address but never the key", () => {
  const paths = { nodePath: "/node", appleServerPath: "/apple/server.mjs", kaneoServerPath: "/console/kaneo-mcp.mjs" };
  const off = { appleNotes: false, appleCalendar: false };
  assert.deepEqual(configuredMcpServers({ ...off, kaneo: true, kaneoUrl: "" }, paths), []);
  assert.deepEqual(configuredMcpServers({ ...off, kaneo: false, kaneoUrl: "https://k.example/api" }, paths), []);
  const servers = configuredMcpServers({ ...off, kaneo: true, kaneoUrl: "https://k.example/api" }, paths);
  assert.deepEqual(servers, [{
    name: "kaneo",
    command: "/node",
    args: ["/console/kaneo-mcp.mjs"],
    env: [{ name: "KANEO_BASE_URL", value: "https://k.example/api" }]
  }]);
  assert.doesNotMatch(JSON.stringify(servers), /KEY|key/);
});
