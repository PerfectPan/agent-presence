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

/** A date naming a snapshot of the model before it, as the kit's table writes one. */
const DATED = /(?:[-@]\d{8}|-\d{4}-\d{2}-\d{2})$/;

/**
 * The series whose agents record suffixed variants of the models the kit's
 * table names: Claude (`-thinking`, `[1m]`, Bedrock's `us.anthropic.…-v1:0`),
 * GPT-5 (Codex's `-codex` and reasoning efforts such as `-high`) and DeepSeek
 * V4 (`-thinking`). Bare `gpt-5` is left out: every GPT-5 id contains it, so
 * an unlisted version such as `gpt-5.7` would take GPT-5's price, a quarter of
 * `gpt-5.5`'s input price.
 */
const ALIASED_SERIES = /^(?:claude-|gpt-5[.-]|deepseek-v4)/i;

/**
 * The table's undated models of `ALIASED_SERIES` as fallback aliases, each at
 * its own table price. The table prices only the ids it names, with or
 * without a date; an id it does not name takes the longest alias it contains,
 * so a suffixed variant such as `claude-opus-5-5-thinking` or
 * `gpt-5.4-mini-high` takes its own model's price rather than a shorter
 * model's (`claude-opus-5`, `gpt-5.4`). Dated keys are left out because their
 * model's undated key is contained in the same ids. The cost, which presence
 * accepts: a new model whose name extends a tabled one, such as
 * `claude-opus-5-6` or `gpt-5.10`, takes the older model's price until the
 * kit's table names it.
 */
function tableModelAliases(): Record<string, ModelPricing> {
  return Object.fromEntries(
    Object.entries(litellmPrices).filter(([model]) => ALIASED_SERIES.test(model) && !DATED.test(model))
  );
}

/**
 * Claude family aliases and the table model whose price each one charges: the
 * last resort for a Claude id that contains none of the table's models, such
 * as `claude-opus-4-9` before the kit's table names it. GPT-5 has no family
 * alias: its versions differ in price up to fourfold, so an unlisted one stays
 * unpriced rather than priced as another.
 */
const FAMILY_MODELS: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5'
};

/**
 * Last list prices of models the kit's table does not name, which would
 * otherwise take a family alias's price or none. Claude Opus 4, Opus 4.1 and
 * Claude 3 Opus cost three times the `opus` alias: Anthropic lists them at $15
 * input, $18.75 and $30 five-minute and one-hour cache writes, $1.50 cache
 * reads and $75 output. LiteLLM no longer lists Opus 4.1 and
 * `gemini-3-pro-preview` under their own provider, while Bedrock and Vertex AI
 * still serve them. As aliases they also price the dated and Bedrock-style ids
 * that contain them; Opus 4 is keyed by its dated id because every later
 * Opus 4.x id contains `claude-opus-4`.
 */
const RETIRED_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-20250514': { input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  'claude-3-opus': { input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  'gemini-3-pro-preview': { input: 2, output: 12, cacheWrite: 2, cacheRead: 0.2 }
};

const FALLBACK_PRICING: Record<string, ModelPricing> = {
  ...Object.fromEntries(
    Object.entries(FAMILY_MODELS).flatMap(([alias, model]): [string, ModelPricing][] => {
      const price = litellmPrices[model];
      return price === undefined ? [] : [[alias, price]];
    })
  ),
  ...RETIRED_PRICING,
  // Last, so a retired model the table names again takes its table price.
  ...tableModelAliases()
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
