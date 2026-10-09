// Indicative USD API text-token rates per million. Short Claude Code aliases
// follow the latest model in each family, so these are estimates, not bills.
const CLAUDE_RATES = {
  sonnet: { input: 3, output: 15, read: 0.30, write: 3.75 },
  opus: { input: 5, output: 25, read: 0.50, write: 6.25 },
  haiku: { input: 1, output: 5, read: 0.10, write: 1.25 }
};

// Verified standard-tier USD text rates per million from
// https://developers.openai.com/api/docs/pricing (not subscription charges).
// Keep exact IDs: cache discounts vary by model (e.g. GPT-6.1 Sol is 5%).
const CODEX_RATES = {
  'gpt-5': { input: 1.25, output: 10, read: 0.125 },
  'gpt-5.1': { input: 1.25, output: 10, read: 0.125 },
  'gpt-5.2': { input: 1.75, output: 14, read: 0.175 },
  'gpt-6-sol': { input: 2, output: 10, read: 0.2, write: 2.5 },
  'gpt-6.1-sol': { input: 2, output: 10, read: 0.1, write: 2.5 }
};

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// Whether the displayed amount relies on the 10% cache-read heuristic,
// rather than the published rate for the exact model.
export function assumesCacheReadRate(usage, provider, model, reference = null) {
  const id = typeof model === 'string' ? model.toLowerCase() : '';
  return provider === 'openai-codex' && !Object.hasOwn(CODEX_RATES, id)
    && Number.isFinite(reference?.pricing?.input) && reference.pricing.input >= 0
    && !Number.isFinite(reference?.pricing?.read) && count(usage?.cachedReadTokens) > 0;
}

export function apiEquivalent(usage, provider, model, reference = null) {
  const id = typeof model === 'string' ? model.toLowerCase() : '';
  const rates = provider === 'claude-code'
    ? (CLAUDE_RATES[id] || (id === 'claude-sonnet-4-5' ? CLAUDE_RATES.sonnet
      : id === 'claude-opus-4-5' ? CLAUDE_RATES.opus
        : id === 'claude-haiku-4-5' ? CLAUDE_RATES.haiku : null))
    : provider === 'openai-codex' ? (CODEX_RATES[id] || (reference?.pricing ? {
      ...reference.pricing,
      // Heuristic for an unlisted OpenAI model. GPT-5 and GPT-6 Sol standard
      // cache reads cost 10% of input, but some models differ. Do not guess
      // the cache-write rate when the catalog doesn't publish it.
      read: reference.pricing.read ?? reference.pricing.input * 0.1
    } : null)) : null;
  if (!rates) return null;

  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  const read = count(usage?.cachedReadTokens);
  const write = count(usage?.cachedWriteTokens);
  // Both cache categories are included in input; never count either twice.
  if (read + write > input || (read && !Number.isFinite(rates.read))
    || (write && !Number.isFinite(rates.write))) return null;
  const amount = ((input - read - write) * rates.input + read * (rates.read ?? 0)
    + write * (rates.write ?? 0) + output * rates.output) / 1_000_000;
  return Number.isFinite(amount) ? amount : null;
}

export function threadContextPercent(usage) {
  const used = usage?.used, size = usage?.size;
  if (!Number.isFinite(used) || !Number.isFinite(size) || used < 0 || size <= 0) return null;
  return Math.round(100 * used / size);
}
