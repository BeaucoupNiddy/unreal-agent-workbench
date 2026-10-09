#!/usr/bin/env node
const request = JSON.parse(process.argv.at(-1));
request.prompt ||= request.messages?.map((message) => message.content).join("\n");
const reply = (id, usage) => ({ Kind: "model_response", Data: { Response: {
  ID: id, Usage: usage, Output: [{ Type: "message", Data: { Phase: "final", Text: request.prompt } }]
} } });
const first = reply("usage-one", {
  InputTokens: 100, OutputTokens: 20, CachedInputTokens: 40,
  CacheWriteInputTokens: 10, ReasoningTokens: 5, Raw: { cost: 0.00123 }
});
const second = reply("usage-two", {
  InputTokens: 200, OutputTokens: 30, CachedInputTokens: 150,
  CacheWriteInputTokens: 0, ReasoningTokens: 3, Raw: request.prompt === "unknown" ? {} : { cost: 0.002 }
});
for (const event of [first, first, second]) console.log(JSON.stringify(event));
