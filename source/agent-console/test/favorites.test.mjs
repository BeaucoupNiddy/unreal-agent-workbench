import assert from "node:assert/strict";
import test from "node:test";
import { applyModelFavorites } from "../public/favorites.js";

test("pins only explicit favorites ahead of recommended models", () => {
  const configOptions = [{ id: "model", options: [
    { value: "recommended", name: "Recommended", recommended: true },
    { value: "other", name: "Other" },
    { value: "favorite", name: "Favorite" }
  ] }];
  applyModelFavorites(configOptions, ["favorite"]);
  assert.deepEqual(configOptions[0].options.map((option) => option.value), ["favorite", "recommended", "other"]);
  assert.equal(configOptions[0].options[0].name, "★ Favorite");
  assert.equal(configOptions[0].options[0].favorite, true);
  assert.equal(configOptions[0].options[1].favorite, undefined);
});

test("removing a favorite restores recommendation-first ordering", () => {
  const configOptions = [{ id: "model", options: [
    { value: "favorite", name: "★ Favorite", favorite: true },
    { value: "recommended", name: "Recommended", recommended: true },
    { value: "other", name: "Other" }
  ] }];
  applyModelFavorites(configOptions, []);
  assert.deepEqual(configOptions[0].options.map((option) => option.value), ["recommended", "favorite", "other"]);
  assert.equal(configOptions[0].options[1].name, "Favorite");
  assert.equal(configOptions[0].options[1].favorite, undefined);
});
