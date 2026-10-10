import { promises as fs } from 'node:fs';

// OpenRouter's cached model catalog contains text API rates and context limits.
// This is a reseller reference, not the provider's actual subscription or bill.
export function modelUsageReference(models, provider, model) {
  if (provider !== 'openai-codex' || typeof model !== 'string' || !model || /[/ :]/.test(model)) return null;
  const item = models?.find((entry) => entry.value === `openai/${model}`);
  if (!item) return null;
  const match = item.description?.match(/^\$([\d,.]+) in \/ \$([\d,.]+) out per 1M tokens(?:\s|$)/);
  const input = match ? Number(match[1].replaceAll(',', '')) : null;
  const output = match ? Number(match[2].replaceAll(',', '')) : null;
  return {
    contextWindow: Number.isSafeInteger(item.contextWindow) && item.contextWindow > 0 ? item.contextWindow : null,
    pricing: Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0
      ? { input, output, source: 'OpenRouter' } : null
  };
}

// USD per million text tokens for an OpenRouter model, from the cached catalog.
// The catalog lists only input and output rates.
export function openRouterRates(models, model) {
  if (typeof model !== 'string' || !model) return null;
  const item = models?.find((entry) => entry.value === model);
  const match = item?.description?.match(/^\$([\d,.]+) in \/ \$([\d,.]+) out per 1M tokens(?:\s|$)/);
  const input = match ? Number(match[1].replaceAll(',', '')) : NaN;
  const output = match ? Number(match[2].replaceAll(',', '')) : NaN;
  return Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 ? { input, output } : null;
}

export async function readCatalogModels(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')).models || []; } catch { return []; }
}

export async function readModelUsageReference(file, provider, model) {
  try {
    const catalog = JSON.parse(await fs.readFile(file, 'utf8'));
    return modelUsageReference(catalog.models, provider, model);
  } catch { return null; }
}
