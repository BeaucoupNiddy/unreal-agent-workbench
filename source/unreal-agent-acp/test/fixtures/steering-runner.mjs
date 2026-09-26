#!/usr/bin/env node
import { access, appendFile } from "node:fs/promises";

const request = JSON.parse(process.argv.at(-1));
const workspaceIndex = process.argv.indexOf("-workspace");
const workspace = process.argv[workspaceIndex + 1];
const prompt = request.prompt || request.messages.map((message) => message.content).join("\n");
await appendFile(`${workspace}/prompt-order.txt`, `${prompt}\n`);
await appendFile(`${workspace}/requests.jsonl`, `${JSON.stringify(request)}\n`);
process.stdout.write(`${JSON.stringify({
  Kind: "input", Data: { Kind: "external", Payload: prompt }
})}\n`);

if (prompt === "first task") {
  process.stdout.write(`${JSON.stringify({
    Kind: "model_response",
    Data: { Response: { Output: [{
      Type: "tool_call", Data: { CallID: "steering-call", Name: "Bash", Arguments: JSON.stringify({ command: "long-running task" }) }
    }] } }
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    Kind: "tool_call_status",
    Data: {
      CallID: "steering-call", Status: { Error: "", WaitingFor: ["steering-operation"] },
      Operations: [{ ID: "steering-operation", Type: "shell", Status: "ready" }]
    }
  })}\n`);
  await appendFile(`${workspace}/tool-active.txt`, "running\n");
  while (await access(`${workspace}/release-tool.txt`).then(() => false, () => true)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.stdout.write(`${JSON.stringify({
    Kind: "tool_call_status",
    Data: {
      CallID: "steering-call", Status: { Error: "", WaitingFor: [] },
      Operations: [{ ID: "steering-operation", Type: "shell", Status: "completed" }]
    }
  })}\n`);
  process.on("SIGINT", () => {
    void appendFile(`${workspace}/interrupted.txt`, "model turn resumed after tool boundary\n").then(() => process.exit(130));
  });
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(`${JSON.stringify({
    Kind: "model_response",
    Data: { Response: { Output: [{
      Type: "message",
      Data: { Phase: "final", Text: `Resumed with steering: ${prompt}` }
    }] } }
  })}\n`);
}
