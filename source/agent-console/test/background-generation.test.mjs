import test from "node:test";
import assert from "node:assert/strict";
import { cleanGeneratedTitle, parseGeneratedMemory, parseGeneratedText } from "../background-generation.mjs";

test("extracts visible model output from runner events", () => {
  const event = { Kind: "model_response", Data: { Response: { Output: [
    { Type: "message", Data: { Phase: "analysis", Text: "hidden" } },
    { Type: "message", Data: { Phase: "message", Text: "Project memory" } }
  ] } } };
  assert.equal(parseGeneratedText(JSON.stringify(event)), "Project memory");
});

test("cleans generated titles", () => {
  assert.equal(cleanGeneratedTitle('Title: "Add Project Memory."\nExtra'), "Add Project Memory");
});

test("normalizes generated memory JSON", () => {
  assert.deepEqual(parseGeneratedMemory('```json\n{"goal":"Ship it","outcome":"Done","rejected_approaches":["Global context"],"open_threads":["Tests"]}\n```'), {
    goal: "Ship it", outcome: "Done", rejectedApproaches: ["Global context"], openThreads: ["Tests"]
  });
});
