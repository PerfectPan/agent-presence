import { createPricing, type Pricing } from '@rivus/agent-kit/cost';
import { litellmPrices } from '@rivus/agent-kit/cost/prices';

/** Per-million-token rates in USD. */
interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  /** One-hour cache creation rate; falls back to cacheWrite when absent. */
  cacheWrite1h?: number;
  cacheRead: number;
}

/**
 * Fallback aliases and the LiteLLM table model whose price each one charges.
 * An id the table has no key for, such as a suffixed variant
 * (`claude-opus-4-8-thinking`, `gpt-5.5-codex`, `gpt-5.6-sol-high`) or a model
 * newer than the kit's snapshot, takes the longest alias its id contains
 * (case-insensitive). A family alias charges its current generation's price,
 * so `opus` prices `claude-opus-4-9` like `claude-opus-4-8`. GPT-5 has no
 * family alias: its minor versions differ in price up to fourfold, so an
 * unlisted one such as `gpt-5.7` stays unpriced rather than priced as another.
 */
const ALIAS_MODELS: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'deepseek-v4-pro': 'deepseek-v4-pro'
};

/**
 * Fallback prices of models LiteLLM no longer lists under their own provider
 * while Bedrock (`claude-opus-4-1`) and Vertex AI (`gemini-3-pro-preview`)
 * still serve them: their last list prices. As aliases they also price the
 * dated and Bedrock-style ids that contain them.
 */
const RETIRED_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  'gemini-3-pro-preview': { input: 2, output: 12, cacheWrite: 2, cacheRead: 0.2 }
};

const FALLBACK_PRICING: Record<string, ModelPricing> = {
  ...Object.fromEntries(
    Object.entries(ALIAS_MODELS).flatMap(([alias, model]): [string, ModelPricing][] => {
      const price = litellmPrices[model];
      return price === undefined ? [] : [[alias, price]];
    })
  ),
  ...RETIRED_PRICING
};

export type PricingOverrides = Record<string, Partial<ModelPricing>>;

// `createPricing` caches its model lookups per instance and the tables never
// change, so one instance per overrides value serves every record of a run;
// keyed weakly so a per-command config load does not pin the previous one.
// The key is the overrides object's identity: a caller that mutates an
// overrides object in place would keep reading the pricing built from its old
// content, so pass a fresh object instead.
const pricingByOverrides = new WeakMap<PricingOverrides, Pricing>();

// The shared no-override key, so the common `resolvePricing(model)` shape
// reuses one pricing instance instead of building one per call.
const NO_OVERRIDES: PricingOverrides = {};

function pricingFor(overrides: PricingOverrides = NO_OVERRIDES): Pricing {
  let pricing = pricingByOverrides.get(overrides);
  if (pricing === undefined) {
    pricing = createPricing(litellmPrices, { overrides, fallback: FALLBACK_PRICING });
    pricingByOverrides.set(overrides, pricing);
  }
  return pricing;
}

/**
 * The pricing the totals are computed through: the kit's `summarize` and
 * `costOf` take it, applying a logged cost unmultiplied and a table cost times
 * the record's pricing multiplier. One instance per overrides value.
 */
export function usagePricing(overrides?: PricingOverrides): Pricing {
  return pricingFor(overrides);
}

/**
 * Resolve pricing for a model id; keys match regardless of case. Resolution
 * order:
 *
 * 1. `config.usage.pricing` overrides: the longest key the id contains
 * 2. the kit's LiteLLM table (`@rivus/agent-kit/cost/prices`): the key equal
 *    to the id, or to the id without a date suffix or a `<provider>/` prefix
 * 3. the fallback aliases: the longest key the id contains
 *
 * A partial override takes its missing rates from the id's own price (2 or 3);
 * an id without one stays unpriced. Returns `null` when nothing matches,
 * signalling "cost unknown".
 */
export function resolvePricing(model: string, overrides: PricingOverrides = NO_OVERRIDES): ModelPricing | null {
  const price = pricingFor(overrides).priceOf(model);
  // A fresh object per call: the kit hands out its shared table entries.
  return price === undefined ? null : { ...price };
}
