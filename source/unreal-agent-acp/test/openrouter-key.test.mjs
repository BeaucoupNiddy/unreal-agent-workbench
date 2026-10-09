import assert from "node:assert/strict";
import test from "node:test";
import { clearOpenRouterKey, keychainService, legacyKeychainService, readOpenRouterKey, saveOpenRouterKey, verifyOpenRouterKey } from "../src/openrouter-key.mjs";

// A fake `security` command backed by a map of keychain items.
function keychain(items = {}) {
  const calls = [];
  const security = async (args) => {
    calls.push(args);
    const service = args[args.indexOf("-s") + 1];
    if (args[0] === "find-generic-password") {
      if (!(service in items)) throw new Error("not found");
      return { stdout: `${items[service]}\n` };
    }
    if (args[0] === "add-generic-password") items[service] = args[args.indexOf("-w") + 1];
    if (args[0] === "delete-generic-password") delete items[service];
    return { stdout: "" };
  };
  return { items, calls, security };
}

const key = "sk-or-v1-placeholder-for-tests-only";

test("saves, reads and clears the key in the keychain, including the legacy copy", async () => {
  const fake = keychain({ [legacyKeychainService]: "legacy-key-0123456789abcdef" });
  assert.equal(await readOpenRouterKey({ security: fake.security, env: {} }), "legacy-key-0123456789abcdef");
  assert.equal(fake.items[keychainService], "legacy-key-0123456789abcdef");
  await saveOpenRouterKey(`  ${key} `, { security: fake.security });
  assert.equal(await readOpenRouterKey({ security: fake.security, env: {} }), key);
  assert.ok(fake.calls.some((args) => args[0] === "add-generic-password" && args.includes("-U")));
  await clearOpenRouterKey({ security: fake.security });
  assert.deepEqual(fake.items, {});
  assert.equal(await readOpenRouterKey({ security: fake.security, env: {} }), "");
  assert.equal(await readOpenRouterKey({ security: fake.security, env: { OPENROUTER_API_KEY: "from-env" } }), "from-env");
});

test("rejects incomplete keys before touching the keychain", async () => {
  const fake = keychain();
  await assert.rejects(saveOpenRouterKey("sk-or-short", { security: fake.security }), /looks incomplete/);
  await assert.rejects(saveOpenRouterKey(`${key} extra`, { security: fake.security }), /looks incomplete/);
  assert.equal(fake.calls.length, 0);
});

test("only a 401 or 403 from OpenRouter counts as a bad key", async () => {
  const reply = (status) => async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/key");
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    return { status, ok: status === 200 };
  };
  assert.deepEqual(await verifyOpenRouterKey(key, { fetch: reply(200) }), { valid: true, checked: true });
  assert.deepEqual(await verifyOpenRouterKey(key, { fetch: reply(401) }), { valid: false });
  assert.deepEqual(await verifyOpenRouterKey(key, { fetch: reply(503) }), { valid: true, checked: false });
  assert.deepEqual(await verifyOpenRouterKey(key, { fetch: async () => { throw new Error("offline"); } }), { valid: true, checked: false });
});
