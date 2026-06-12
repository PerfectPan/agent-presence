import { resolveRecordCost, type PricingOverrides } from './pricing.js';
import { scanClaude } from './scan-claude.js';
import { scanCodex } from './scan-codex.js';
import { scanPi } from './scan-pi.js';
import type { SourceUsage, UsageRecord, UsageSource, UsageTotals, WindowUsage } from './types.js';

export type { ModelPricing, PricingOverrides } from './pricing.js';
export type { SourceUsage, UsageRecord, UsageSource, UsageTotals, WindowUsage } from './types.js';
export { DEFAULT_PRICING, resolvePricing, resolveRecordCost } from './pricing.js';

export interface CollectOptions {
  /** Rolling-window length in days; the window is `[now - days*24h, now)`. */
  days: number;
  /** Window upper bound (epoch ms); defaults supplied by the caller. */
  now: number;
  pricing?: PricingOverrides;
  /** Per-source root overrides, mainly for tests. */
  roots?: Partial<Record<UsageSource, string>>;
}

const SOURCE_ORDER: UsageSource[] = ['claude', 'codex', 'pi'];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Collect token usage across all supported sources for a rolling window ending
 * at `now`. Gemini is intentionally absent: it does not persist per-message
 * token usage locally, so it cannot be accounted for.
 */
export async function collectWindowUsage(options: CollectOptions): Promise<WindowUsage> {
  const untilMs = options.now;
  const sinceMs = options.now - options.days * DAY_MS;
  const scanOptions = { sinceMs, untilMs };

  const [claude, codex, pi] = await Promise.all([
    scanClaude({ ...scanOptions, root: options.roots?.claude }),
    scanCodex({ ...scanOptions, root: options.roots?.codex }),
    scanPi({ ...scanOptions, root: options.roots?.pi })
  ]);

  const records = [...claude, ...codex, ...pi];
  const bySource = SOURCE_ORDER.map((source) =>
    summarise(source, records.filter((record) => record.source === source), options.pricing)
  );

  return {
    sinceMs,
    untilMs,
    bySource,
    total: combineTotals(bySource)
  };
}

function summarise(source: UsageSource, records: UsageRecord[], pricing?: PricingOverrides): SourceUsage {
  const totals = emptyTotals();
  let sawCost = false;

  for (const record of records) {
    totals.inputTokens += record.inputTokens;
    totals.outputTokens += record.outputTokens;
    totals.cacheWriteTokens += record.cacheWriteTokens;
    totals.cacheReadTokens += record.cacheReadTokens;

    const cost = resolveRecordCost(record, pricing);
    if (cost !== null) {
      sawCost = true;
      totals.costUsd = (totals.costUsd ?? 0) + cost;
    }
  }

  totals.totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheWriteTokens + totals.cacheReadTokens;
  if (!sawCost) {
    totals.costUsd = null;
  }

  return { source, entries: records.length, ...totals };
}

function combineTotals(groups: UsageTotals[]): UsageTotals {
  const totals = emptyTotals();
  let sawCost = false;
  for (const group of groups) {
    totals.inputTokens += group.inputTokens;
    totals.outputTokens += group.outputTokens;
    totals.cacheWriteTokens += group.cacheWriteTokens;
    totals.cacheReadTokens += group.cacheReadTokens;
    totals.totalTokens += group.totalTokens;
    if (group.costUsd !== null) {
      sawCost = true;
      totals.costUsd = (totals.costUsd ?? 0) + group.costUsd;
    }
  }
  if (!sawCost) {
    totals.costUsd = null;
  }
  return totals;
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };
}
