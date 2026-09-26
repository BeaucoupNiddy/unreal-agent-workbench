import assert from "node:assert/strict";
import test from "node:test";
import { moveId, moveIdBy, orderedByIds } from "../public/sidebar-order.js";

test("applies saved order and leaves new items at the end", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(orderedByIds(items, ["c", "a"], (item) => item.id).map((item) => item.id), ["c", "a", "b"]);
});

test("moves an item before a drop target", () => {
  assert.deepEqual(moveId(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
});

test("keyboard reorder clamps at the edges", () => {
  assert.deepEqual(moveIdBy(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveIdBy(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
});
