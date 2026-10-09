#!/usr/bin/env node
// Fake swarm member. Its task text picks a scenario; peers talk through the real
// capability CLI so routing, delivery and acknowledgments are exercised end to end.
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "unreal-capability.mjs");
const request = JSON.parse(process.argv.at(-1));
const live = process.argv.includes("-live-input");
const name = /You are "([^"]+)"/.exec(request.system_prompt)[1];
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (text) => emit({ Kind: "model_response", Data: { Response: { ID: `${request.session_id}-${Math.random()}`,
  Usage: { InputTokens: 100, OutputTokens: 10, Raw: { cost: 0.001 } }, Output: [{ Type: "message", Data: { Phase: "final", Text: text } }] } } });
const capability = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }).trim();
const finish = (text) => { respond(text); process.stdout.write("", () => process.exit(0)); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const message of request.messages || []) emit({ Kind: "input", Data: { Kind: "external", ID: message.message_id } });
const opening = live ? request.messages.map((message) => message.content).join("\n") : request.prompt;

const received = [];
if (live) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    for (const message of JSON.parse(line).messages || []) {
      emit({ Kind: "input", Data: { Kind: "external", ID: message.message_id } });
      received.push(message.content);
    }
  });
}
async function waitForMessage() {
  for (let tries = 0; tries < 200 && !received.length; tries += 1) {
    if (!live) { const inbox = capability("swarm-inbox"); if (!inbox.startsWith("No new")) received.push(inbox); }
    if (!received.length) await sleep(20);
  }
}

if (opening.startsWith("[Swarm message")) finish(`${name} woken by: ${opening}`);
else if (opening.includes("fail")) { console.error("model unavailable"); process.exit(3); }
else if (opening.includes("discuss")) {
  emit({ Kind: "model_response", Data: { Response: { Output: [{ Type: "tool_call", Data: { CallID: `${name}-send`, Name: "Bash",
    Arguments: JSON.stringify({ command: "unreal-capability swarm-send" }) } }] } } });
  capability("swarm-send", JSON.stringify({ to: "all", message: `${name} found ${name}-fact` }));
  await waitForMessage();
  finish(`${name} heard: ${received.join(" | ")}`);
} else if (opening.includes("wake")) {
  if (name.endsWith("-2")) finish(`${name} done early`);
  else { await sleep(300); capability("swarm-send", JSON.stringify({ to: name.replace(/-1$/, "-2"), message: "Please double-check this" })); finish(`${name} done`); }
} else if (opening.includes("wait")) { await sleep(30_000); finish("late"); }
else finish(`${name} solo`);
