import { summarize, type Pricing } from '@rivus/agent-kit/cost';
import { createNodePlatform } from '@rivus/agent-kit/node';
import { isUsageRecord, noCacheInputTokens, scanUsage as scanKitUsage } from '@rivus/agent-kit/transcript/usage';
import type { UsageRecord as KitUsageRecord } from '@rivus/agent-kit/transcript/usage';

import { writeLog } from '../log.js';
import { DAY_MS, startOfLocalDayMs } from '../time.js';
import { toKitRecord } from './kit.js';
import { usagePricing, type PricingOverrides } from './pricing.js';
import type {
  BillableSource,
  ScanEnvironment,
  SourceUsage,
  UsageRecord,
  UsageSource,
  UsageTotals,
  WindowUsage
} from './types.js';

export type { PricingOverrides } from './pricing.js';
export type { BillableSource, HandlerBillableSource, SourceUsage, UsageRecord, WindowUsage } from './types.js';
export { resolvePricing } from './pricing.js';

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
   * via `billableSources()` (see `src/usage/billable-sources.ts`) so every window in a run uses
   * the same set and order.
   */
  sources: BillableSource[];
  /** The environment the scan reads its transcript roots from; `process.env` when absent. */
  env?: ScanEnvironment;
  /** Reject the collection when any source fails instead of treating it as empty. */
  failOnSourceError?: boolean;
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

function summarise(source: UsageSource, records: KitUsageRecord[], pricing: Pricing): SourceUsage {
  const total = summarize(records, pricing, { groupBy: [] }).total;
  const inputTokens = total.usage.inputTokens ?? 0;
  const outputTokens = total.usage.outputTokens ?? 0;
  const cacheWriteTokens = total.usage.cacheWriteTokens ?? 0;
  const cacheReadTokens = total.usage.cacheReadTokens ?? 0;

  return {
    source,
    entries: total.entries,
    // The kit's input includes the cache counts reported below; the reported
    // field keeps the input that was neither read from nor written to a cache.
    inputTokens: noCacheInputTokens(total.usage) ?? 0,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    // The badge total is the kit's two-bucket sum: the cache counts are
    // subsets of the kit's input, never additions.
    totalTokens: inputTokens + outputTokens,
    costUsd: total.costUsd ?? null
  };
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/**
 * One stateless kit scan over every kit-decoded source of the window. Every
 * call re-reads the whole window — no scan state is kept — so overlapping
 * scans are idempotent and a price change applies on the next scan. The
 * platform's clock reads the window's `now`, which also makes the kit's
 * 30-minute quiet rule deterministic under an injected time.
 */
async function scanKitAgents(
  agents: string[],
  window: { sinceMs: number; untilMs: number; now: number; env?: ScanEnvironment }
): Promise<Map<string, KitUsageRecord[]>> {
  const byAgent = new Map(agents.map((agent) => [agent, [] as KitUsageRecord[]]));
  const base = createNodePlatform({ env: window.env ?? process.env });
  const platform = { ...base, clock: { ...base.clock, now: () => window.now } };
  const scan = scanKitUsage(platform, { agents, since: window.sinceMs, until: window.untilMs });
  for await (const item of scan) {
    // A decode failure skips only the source that failed: the records it
    // yielded before the failure stay valid, and its agent's other sources
    // still count. Every failure but a missing root writes one log line with
    // the agent and the failure kind.
    if (isUsageRecord(item)) {
      byAgent.get(item.agent)?.push(item);
    } else if (item.error._tag !== 'RootMissing') {
      await writeLog(`usage scan failed agent=${item.agent} error=${item.error._tag}`).catch(() => {});
    }
  }
  return byAgent;
}

/**
 * Collect token usage across the billable sources for a calendar-day window
 * ending at `now`. The lower bound snaps to local midnight so "today" resets at
 * 00:00 and never shrinks mid-day, rather than sliding as a rolling 24h window
 * would.
 *
 * Sources are iterated dynamically from the merged source table (each source is
 * one thing that declares all its capabilities), not a hardcoded set. The
 * kit-decoded built-ins share one kit `scanUsage` call per window; a custom
 * handler source and dsh run their own scanner, and their records are converted
 * to the kit record shape at this totals boundary. A source whose scan throws
 * is isolated: its failure is logged and it contributes nothing, mirroring how
 * presence resolution fails open — one unreadable transcript store never breaks
 * the whole run. Atomic cache callers can opt into rejection with
 * `failOnSourceError` so a failed scan is not mistaken for a real zero-usage
 * contribution.
 */
export async function collectWindowUsage(options: CollectOptions): Promise<WindowUsage> {
  const untilMs = options.now;
  const sinceMs = startOfLocalDayMs(options.now) - (options.days - 1) * DAY_MS;
  const pricing = usagePricing(options.pricing);

  const kitAgents: string[] = [];
  for (const source of options.sources) {
    if (source.kitAgent !== undefined && !kitAgents.includes(source.kitAgent)) {
      kitAgents.push(source.kitAgent);
    }
  }

  let kitRecords = new Map<string, KitUsageRecord[]>();
  if (kitAgents.length > 0) {
    try {
      kitRecords = await scanKitAgents(kitAgents, {
        sinceMs,
        untilMs,
        now: options.now,
        env: options.env
      });
    } catch (error) {
      // Fail-soft: one unreadable transcript store must not break the whole run,
      // mirroring how presence resolution fails open. Log it (redaction-safe,
      // name only); a log-write failure must not resurface as the scan error.
      await writeLog(`usage scan failed agents=${kitAgents.join(',')} error=${errorName(error)}`).catch(() => {});
      if (options.failOnSourceError) {
        throw error;
      }
      kitRecords = new Map(kitAgents.map((agent) => [agent, [] as KitUsageRecord[]]));
    }
  }

  const bySource = await Promise.all(
    options.sources.map(async (source): Promise<SourceUsage> => {
      let records: KitUsageRecord[];
      if (source.kitAgent !== undefined) {
        records = kitRecords.get(source.kitAgent) ?? [];
      } else {
        const scanned = await source.scanUsage({ sinceMs, untilMs, env: options.env }).catch(async (error) => {
          await writeLog(`usage scan failed source=${source.id} error=${errorName(error)}`).catch(() => {});
          if (options.failOnSourceError) {
            throw error;
          }
          return [] as UsageRecord[];
        });
        records = scanned.map((record) => toKitRecord(record, source.id));
      }
      return summarise(source.id, records, pricing);
    })
  );

  return {
    sinceMs,
    untilMs,
    bySource,
    total: combineTotals(bySource)
  };
}
