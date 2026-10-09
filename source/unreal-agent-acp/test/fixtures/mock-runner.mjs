#!/usr/bin/env node
const request = JSON.parse(process.argv.at(-1));
request.prompt ||= request.messages?.map((message) => message.content).join("\n");

process.stdout.write(`${JSON.stringify({
  Kind: "model_response",
  Data: { Response: { Output: [{
    Type: "tool_call",
    Data: { CallID: "mock-call", Name: "Bash", Arguments: JSON.stringify({ command: "pwd" }) }
  }] } }
})}\n`);
process.stdout.write(`${JSON.stringify({
  Kind: "tool_call_status",
  Data: {
    CallID: "mock-call",
    Status: { Error: "", WaitingFor: ["mock-op"] },
    Operations: [{ ID: "mock-op", Type: "shell", Status: "completed" }]
  }
})}\n`);
process.stdout.write(`${JSON.stringify({
  Kind: "model_response",
  Data: { Response: { Output: [{
    Type: "message",
    Data: { ID: "mock-message", Phase: "final", Text: `Mock received: ${request.prompt}` }
  }] } }
})}\n`);
