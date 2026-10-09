#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const request = JSON.parse(process.argv.at(-1));
request.prompt ||= request.messages?.map((message) => message.content).join("\n") || "";
if (process.env.SUBAGENT_RECORD) writeFileSync(process.env.SUBAGENT_RECORD, JSON.stringify({
  request, args: process.argv.slice(2, -1), provider: process.env.UNREAL_HARNESS_LLM_PROVIDER,
  model: process.env.UNREAL_HARNESS_LLM_MODEL, sessionId: process.env.UNREAL_AGENT_SESSION_ID
}));
if (request.prompt.includes("fail")) { console.error("model unavailable"); process.exit(3); }
if (request.prompt.includes("wait")) await new Promise((resolve) => setTimeout(resolve, 30_000));
// Plans such as Codex report no per-request charge.
const priced = !request.prompt.includes("plan model");
const response = (id, text, usage) => ({ Kind: "model_response", Data: { Response: { ID: id,
  Usage: priced ? usage : { ...usage, Raw: undefined },
  Output: [{ Type: "message", Data: { Phase: "final", Text: text } }] } } });
if (request.prompt.includes("steps")) {
  console.log(JSON.stringify({ Kind: "model_response", Data: { Response: { ID: `${request.session_id}-0`, Usage: { InputTokens: 10, OutputTokens: 1, Raw: { cost: 0.0001 } },
    Output: [{ Type: "tool_call", Data: { CallID: "call-1", Name: "Bash", Arguments: JSON.stringify({ command: "rg loadConfig src" }) } }] } } }));
  console.log(JSON.stringify({ Kind: "tool_call_status", Data: { CallID: "call-1", Operations: [{ ID: "op", Status: "completed", State: { Result: { Out: "src/config.mjs", ExitCode: 0 } } }] } }));
}
console.log(JSON.stringify(response(`${request.session_id}-1`, "Looking around.", { InputTokens: 100, OutputTokens: 10, Raw: { cost: 0.001 } })));
console.log(JSON.stringify(response(`${request.session_id}-1`, "Looking around.", { InputTokens: 100, OutputTokens: 10, Raw: { cost: 0.001 } })));
console.log(JSON.stringify(response(`${request.session_id}-2`, `Report for: ${request.prompt}`, { InputTokens: 200, OutputTokens: 20, Raw: { cost: 0.002 } })));
