import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { apiEquivalent, apiRates, assumesCacheReadRate } from './public/usage-equivalent.js';
import { modelUsageReference, openRouterRates, readModelUsageReference } from './model-usage-reference.mjs';
import { readAuxiliaryUsage } from '../unreal-agent-acp/src/auxiliary-usage.mjs';

const subscriptions = new Set(['claude-code', 'openai-codex']);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const paidApi = (provider) => provider === 'openrouter' || provider === 'openai-api' || provider === 'anthropic-api';
const groupOf = (provider) => subscriptions.has(provider) ? 'subscriptions' : paidApi(provider) ? 'api' : null;
const blank = () => ({ inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, tokens: 0, dollars: 0, unpricedTokens: 0, models: {} });

function add(bucket, event, amount) {
  const input = count(event.inputTokens), output = count(event.outputTokens), cached = count(event.cachedReadTokens);
  bucket.inputTokens += input;
  bucket.outputTokens += output;
  bucket.cachedReadTokens += cached;
  bucket.tokens += input + output;
  if (amount === null) bucket.unpricedTokens += input + output;
  else bucket.dollars += amount;
  const model = typeof event.model === 'string' && event.model ? event.model : 'Unknown model';
  const key = `${event.provider}:${model}`;
  const row = bucket.models[key] ||= { provider: event.provider, model, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, tokens: 0, dollars: 0, unpricedTokens: 0 };
  row.tokens += input + output;
  row.inputTokens += input;
  row.outputTokens += output;
  row.cachedReadTokens += cached;
  if (amount === null) row.unpricedTokens += input + output;
  else row.dollars += amount;
}
function finish(bucket) {
  return { ...bucket, models: Object.values(bucket.models).sort((a, b) => b.tokens - a.tokens) };
}
function weekStart(date) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  return value.toISOString().slice(0, 10);
}

// Events are timestamped at response completion. Legacy cumulative counters have no
// timestamps and must never be assigned to a week, month, or currently selected model.
export async function usageDashboard(sessions, { metadataDir, catalogFile, now = new Date(), auxiliaryDataDir = path.dirname(metadataDir) }) {
  const current = new Date(now);
  const referenceCache = new Map();
  const sections = Object.fromEntries(['subscriptions', 'api'].map((key) => [key,
    { allTime: blank(), purposes: new Map(), agents: new Map(), weeks: new Map(), months: new Map(), earlierInputTokens: 0, earlierOutputTokens: 0, earlierCachedReadTokens: 0 }]));
  const active = new Set();
  const metadata = [];
  for (const session of sessions) {
    const id = session?.upstreamSessionId;
    if (typeof id !== 'string' || !id.startsWith('unreal-') || active.has(id)) continue;
    active.add(id);
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(metadataDir, `${createHash('sha256').update(id).digest('hex')}.json`), 'utf8'));
    } catch { continue; }
    if (meta.id !== id) continue;
    metadata.push(meta);
  }
  for (const event of await readAuxiliaryUsage(auxiliaryDataDir)) metadata.push({ provider: event.provider, usage: { events: [event] } });
  for (const meta of metadata) {
    const events = Array.isArray(meta.usage?.events) ? meta.usage.events : [];
    let loggedInput = 0, loggedOutput = 0, loggedCached = 0;
    // Each response is grouped by the provider that served it, so a Codex chat's
    // OpenRouter subagents count as API charges (and the reverse).
    for (const event of events) {
      if (!event || !Number.isFinite(Date.parse(event.at))) continue;
      const date = new Date(event.at);
      if (date > current) continue;
      loggedInput += count(event.inputTokens);
      loggedOutput += count(event.outputTokens);
      loggedCached += count(event.cachedReadTokens);
      const provider = event.provider || meta.provider;
      const group = groupOf(provider);
      if (!group) continue;
      const section = sections[group];
      let amount = null;
      if (group === 'api') amount = Number.isFinite(event.cost) && event.cost >= 0 ? event.cost : null;
      else {
        if (Number.isFinite(event.equivalent) && event.equivalent >= 0) amount = event.equivalent;
        else {
          const cacheKey = `${provider}:${event.model}`;
          if (!referenceCache.has(cacheKey)) referenceCache.set(cacheKey,
            await readModelUsageReference(catalogFile, provider, event.model));
          amount = apiEquivalent(event, provider, event.model, referenceCache.get(cacheKey));
        }
      }
      add(section.allTime, event, amount);
      const purpose = ['title', 'memory', 'synopsis', 'subagent'].includes(event.purpose) ? event.purpose : 'main';
      add(section.purposes.get(purpose) || (section.purposes.set(purpose, blank()), section.purposes.get(purpose)), event, amount);
      if (purpose === 'subagent') {
        const agent = typeof event.agent === 'string' && event.agent ? event.agent : 'unknown';
        add(section.agents.get(agent) || (section.agents.set(agent, blank()), section.agents.get(agent)), event, amount);
      }
      const week = weekStart(date), month = date.toISOString().slice(0, 7);
      add(section.weeks.get(week) || (section.weeks.set(week, blank()), section.weeks.get(week)), event, amount);
      add(section.months.get(month) || (section.months.set(month, blank()), section.months.get(month)), event, amount);
    }
    // Pre-ledger usage is shown separately and excluded from priced/model totals.
    const group = groupOf(meta.provider);
    if (!group) continue;
    const section = sections[group];
    section.earlierInputTokens += Math.max(0, count(meta.usage?.inputTokens) - loggedInput);
    section.earlierOutputTokens += Math.max(0, count(meta.usage?.outputTokens) - loggedOutput);
    section.earlierCachedReadTokens += Math.max(0, count(meta.usage?.cachedReadTokens) - loggedCached);
  }
  return Object.fromEntries(Object.entries(sections).map(([key, section]) => {
    const weeks = [], months = [];
    for (let i = 0; i < 8; i++) {
      const date = new Date(current); date.setUTCDate(date.getUTCDate() - i * 7);
      const start = weekStart(date);
      weeks.push({ start, ...finish(section.weeks.get(start) || blank()) });
    }
    for (let i = 0; i < 6; i++) {
      const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
      months.push({ start, ...finish(section.months.get(start) || blank()) });
    }
    return [key, { allTime: finish(section.allTime),
      purposes: Object.fromEntries([...section.purposes].map(([purpose, bucket]) => [purpose, finish(bucket)])),
      agents: Object.fromEntries([...section.agents].map(([agent, bucket]) => [agent, finish(bucket)])),
      earlierTokens: section.earlierInputTokens + section.earlierOutputTokens,
      earlierInputTokens: section.earlierInputTokens, earlierOutputTokens: section.earlierOutputTokens,
      earlierCachedReadTokens: section.earlierCachedReadTokens, weeks, months }];
  }));
}

// One chat's subagent spend: actual charges from pay-per-use APIs, plus the
// subagents' token totals so the chat's own API equivalent can leave them out.
export function subagentUsage(events = []) {
  const result = { apiCost: 0, apiResponses: 0, unpricedApiResponses: 0, tokens: 0,
    inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.purpose !== 'subagent') continue;
    for (const key of ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens']) result[key] += count(event[key]);
    result.tokens += count(event.inputTokens) + count(event.outputTokens);
    if (!paidApi(event.provider)) continue;
    result.apiResponses += 1;
    if (Number.isFinite(event.cost) && event.cost >= 0) result.apiCost += event.cost;
    else result.unpricedApiResponses += 1;
  }
  return result.tokens ? result : null;
}

// Per-token text rates (USD per million) for any provider, from bundled API rates
// or the OpenRouter catalog. Local models cost nothing per token.
function tokenRates(provider, model, models) {
  if (typeof provider === 'string' && provider.startsWith('local-')) return { input: 0, output: 0, read: 0, write: 0 };
  if (provider === 'openrouter') return openRouterRates(models, model);
  return apiRates(provider, model, modelUsageReference(models, provider, model));
}

// Prices one response's tokens. Unpublished cache rates are assumed: reads at 10%
// of input and writes at 125% (common Anthropic and OpenAI ratios), and flagged.
function priceTokens(event, rates, provider, model, models) {
  const input = count(event.inputTokens), output = count(event.outputTokens);
  const read = count(event.cachedReadTokens), write = count(event.cachedWriteTokens);
  if (read + write > input) return null;
  const readRate = Number.isFinite(rates.read) ? rates.read : rates.input * 0.1;
  const writeRate = Number.isFinite(rates.write) ? rates.write : rates.input * 1.25;
  const assumed = (read > 0 && (!Number.isFinite(rates.read)
      || assumesCacheReadRate(event, provider, model, modelUsageReference(models, provider, model))))
    || (write > 0 && !Number.isFinite(rates.write));
  const amount = ((input - read - write) * rates.input + read * readRate + write * writeRate + output * rates.output) / 1_000_000;
  return Number.isFinite(amount) ? { amount, assumed } : null;
}

// Estimated saving from subagents in one chat: what their tokens would have cost
// at the primary model's per-token price, minus what they cost at their own model's
// price (the reported charge when there is one). Responses that cannot be priced
// on both sides are left out and counted.
export function subagentSavings(events = [], primary = {}, models = []) {
  const primaryRates = tokenRates(primary.provider, primary.model, models);
  if (!primaryRates) return null;
  const result = { primaryCost: 0, subagentCost: 0, saved: 0, responses: 0, unpricedResponses: 0, assumedCacheRate: false };
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.purpose !== 'subagent') continue;
    const asPrimary = priceTokens(event, primaryRates, primary.provider, primary.model, models);
    let actual = null;
    if (paidApi(event.provider) && Number.isFinite(event.cost) && event.cost >= 0) actual = { amount: event.cost, assumed: false };
    else if (Number.isFinite(event.equivalent) && event.equivalent >= 0) actual = { amount: event.equivalent, assumed: false };
    else {
      const rates = tokenRates(event.provider, event.model, models);
      if (rates) actual = priceTokens(event, rates, event.provider, event.model, models);
    }
    if (!asPrimary || !actual) { result.unpricedResponses += 1; continue; }
    result.responses += 1;
    result.primaryCost += asPrimary.amount;
    result.subagentCost += actual.amount;
    result.assumedCacheRate ||= asPrimary.assumed || actual.assumed;
  }
  if (!result.responses && !result.unpricedResponses) return null;
  result.saved = result.primaryCost - result.subagentCost;
  return result;
}
