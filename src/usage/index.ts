import { DAY_MS, startOfLocalDayMs } from '../time.js';
import { writeLog } from '../log.js';
import { resolveRecordCost, type PricingOverrides } from './pricing.js';
import type {
  BillableSource,
  SourceUsage,
  UsageRecord,
  UsageSource,
  UsageTotals,
  WindowUsage
} from './types.js';

export type { ModelPricing, PricingOverrides } from './pricing.js';
export type {
  BillableSource,
  ScanWindow,
  SourceUsage,
  UsageRecord,
  UsageSource,
  UsageTotals,
  WindowUsage
} from './types.js';
export { DEFAULT_PRICING, resolvePricing, resolveRecordCost } from './pricing.js';

export interface CollectOptions {
  /**
   * Number of local calendar days the window spans, inclusive of today. `1` is
   * today since local midnight; `7` is today plus the previous six days. The
   * window is `[startOfLocalDay(now) - (days-1)*24h, now)`.
   */
  days: number;
  /** Window upper bound (epoch ms); defaults supplied by the caller. */
  now: number;
  pricing?: PricingOverrides;
  /**
   * The billable sources to scan, in display order — resolved once by the caller
   * via `billableSources()` (see `src/sources.ts`) so every window in a run uses
   * the same set and order.
   */
  sources: BillableSource[];
  /** Per-source root overrides keyed by source id, mainly for tests. */
  roots?: Record<string, string>;
  /** Reject the collection when any source fails instead of treating it as empty. */
  failOnSourceError?: boolean;
}

/**
 * Collect token usage across the billable sources for a calendar-day window
 * ending at `now`. The lower bound snaps to local midnight so "today" resets at
 * 00:00 and never shrinks mid-day, rather than sliding as a rolling 24h window
 * would.
 *
 * Sources are iterated dynamically from the merged source table (each source is
 * one thing that declares all its capabilities), not a hardcoded set. A source
 * whose scan throws is isolated: its failure is logged and it contributes
 * nothing, mirroring how presence resolution fails open — one unreadable
 * transcript store never breaks the whole run. Atomic cache callers can opt
 * into rejection with `failOnSourceError` so a failed scan is not mistaken for
 * a real zero-usage contribution.
 */
export async function collectWindowUsage(options: CollectOptions): Promise<WindowUsage> {
  const untilMs = options.now;
  const sinceMs = startOfLocalDayMs(options.now) - (options.days - 1) * DAY_MS;

  const perSource = await Promise.all(
    options.sources.map((source) =>
      source.scanUsage({ sinceMs, untilMs, root: options.roots?.[source.id] }).catch(async (error) => {
        // Fail-soft: one source's unreadable data must not break the whole run,
        // mirroring how presence resolution fails open. Log it (redaction-safe,
        // name only); a log-write failure must not resurface as the scan error.
        await writeLog(`usage scan failed source=${source.id} error=${errorName(error)}`).catch(() => {});
        if (options.failOnSourceError) {
          throw error;
        }
        return [] as UsageRecord[];
      })
    )
  );

  const bySource = options.sources.map((source, index) =>
    summarise(source.id, perSource[index], options.pricing)
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
