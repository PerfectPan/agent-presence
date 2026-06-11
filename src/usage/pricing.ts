import type { UsageRecord } from './types.js';

/** Per-million-token rates in USD. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Best-effort default pricing, expressed in USD per million tokens. Keys are
 * lowercase substrings matched against the recorded model id (longest match
 * wins), so `claude-opus-4-8` resolves via the `opus` entry.
 *
 * These mirror published list prices at the time of writing and WILL drift as
 * vendors change pricing. They are overridable per-deployment via
 * `config.usage.pricing` (see `src/config.ts`) so corrections never require a
 * code change. Pi records its own cost in the transcript, so Pi never consults
 * this table.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic (Claude) — standard tier list prices.
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // OpenAI (Codex) — GPT-5 family list prices. OpenAI bills cached input at a
  // reduced rate and has no separate cache-write charge, so cacheWrite mirrors
  // the input rate and cacheRead is the cached-input rate.
  'gpt-5': { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 }
};

export type PricingOverrides = Record<string, Partial<ModelPricing>>;

/**
 * Resolve pricing for a model id. Matches the longest pricing key that is a
 * substring of the lowercased model id. Overrides are merged over the matched
 * default (or used standalone if their key matches and no default does).
 * Returns `null` when nothing matches, signalling "cost unknown".
 */
export function resolvePricing(model: string, overrides: PricingOverrides = {}): ModelPricing | null {
  const id = model.toLowerCase();
  const table: Record<string, Partial<ModelPricing>> = { ...DEFAULT_PRICING, ...mergeOverrides(overrides) };

  let bestKey: string | undefined;
  for (const key of Object.keys(table)) {
    if (id.includes(key.toLowerCase()) && (bestKey === undefined || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  if (bestKey === undefined) {
    return null;
  }

  const merged = table[bestKey];
  if (
    merged.input === undefined ||
    merged.output === undefined ||
    merged.cacheWrite === undefined ||
    merged.cacheRead === undefined
  ) {
    return null;
  }
  return { input: merged.input, output: merged.output, cacheWrite: merged.cacheWrite, cacheRead: merged.cacheRead };
}

function mergeOverrides(overrides: PricingOverrides): Record<string, Partial<ModelPricing>> {
  const merged: Record<string, Partial<ModelPricing>> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const base = DEFAULT_PRICING[key] ?? {};
    merged[key] = { ...base, ...value };
  }
  return merged;
}

/**
 * Compute the USD cost of a usage record. When the record already carries a
 * cost (Pi), that is authoritative. Otherwise the cost is derived from the
 * pricing table; an unknown model yields `null` (token counts stay intact).
 */
export function resolveRecordCost(record: UsageRecord, overrides: PricingOverrides = {}): number | null {
  if (record.costUsd !== null) {
    return record.costUsd;
  }
  const pricing = resolvePricing(record.model, overrides);
  if (pricing === null) {
    return null;
  }
  return (
    (record.inputTokens * pricing.input +
      record.outputTokens * pricing.output +
      record.cacheWriteTokens * pricing.cacheWrite +
      record.cacheReadTokens * pricing.cacheRead) /
    1_000_000
  );
}
