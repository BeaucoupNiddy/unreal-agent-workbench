#!/usr/bin/env node
process.stdout.write(`${JSON.stringify({ Kind: "model_response", Data: { Response: { Output: [{ Type: "message", Data: {
  Phase: "final", Text: JSON.stringify({
    provider: process.env.UNREAL_HARNESS_LLM_PROVIDER,
    model: process.env.UNREAL_HARNESS_LLM_MODEL,
    baseUrl: process.env.UNREAL_HARNESS_LLM_BASE_URL,
    keyMatches: process.env.UNREAL_HARNESS_LLM_API_KEY === "unit-test-secret"
  })
} }] } } })}\n`);
