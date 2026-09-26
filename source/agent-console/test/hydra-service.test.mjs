import test from "node:test";
import assert from "node:assert/strict";
import { assertManagedHydra, servicePid } from "../hydra-service.mjs";

test("accepts only the PID owned by the independent service", () => {
  const output = "gui/503/local.unreal-agent.hydra = {\n\tpid = 12345\n}";
  assert.equal(servicePid(output), 12345);
  assert.doesNotThrow(() => assertManagedHydra(output, 12345));
  assert.throws(() => assertManagedHydra(output, 54321), /independent/);
});

test("a loaded but stopped service does not legitimize an unrelated daemon", () => {
  assert.equal(servicePid("state = waiting\nlast exit code = 0"), null);
  assert.throws(() => assertManagedHydra("state = waiting", 12345), /independent/);
});
