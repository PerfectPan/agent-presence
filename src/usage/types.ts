/**
 * A usage source id. Once billability became a capability of the merged source
 * table (see `rfcs/source-usage.md`), the set is open: any built-in or JS
 * `handler` source that implements `scanUsage` is billable, so this is a plain
 * string rather than the former `'claude' | 'codex' | 'pi'` union.
 */
export type UsageSource = string;

/**
 * The window a scanner reads, plus an optional transcript-root override (mainly
 * for tests). Shared by every `scanUsage` implementation; `ScanOptions` in the
 * individual scanners is an alias of this shape.
 */
export interface ScanWindow {
  /** Inclusive lower bound (epoch ms). */
  sinceMs: number;
  /** Exclusive upper bound (epoch ms); typically "now". */
  untilMs: number;
  /** Override the transcript root (mainly for tests). */
  root?: string;
}

/**
 * A merged-table source that exposes usage scanning. `billableSources()` in
 * `src/sources.ts` resolves these from the source table (in table order) and
 * `collectWindowUsage()` iterates them. Kept in this leaf module so both
 * `src/usage/` and `src/sources.ts` can name it without an import cycle.
 */
export interface BillableSource {
  id: string;
  scanUsage: (window: ScanWindow) => Promise<UsageRecord[]>;
}

/**
 * A single usage record extracted from one agent transcript entry. Token counts
 * are kept in their canonical four buckets so cost can be computed per-bucket.
 */
export interface UsageRecord {
  source: UsageSource;
  /** Model identifier as recorded by the agent (e.g. `claude-opus-4-8`, `gpt-5.5`, `glm-5.1`). */
  model: string;
  /** Epoch milliseconds of the entry, used for time-window filtering. */
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /**
   * Cost in USD when the transcript already carries it (Pi, opencode). `null`
   * means the cost must be derived from a pricing table; `undefined` is never
   * used.
   */
  costUsd: number | null;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  /** Sum of resolved costs; `null` when no record in the group had a known cost. */
  costUsd: number | null;
}

export interface SourceUsage extends UsageTotals {
  source: UsageSource;
  /** Number of transcript entries that contributed to this group. */
  entries: number;
}

export interface WindowUsage {
  /** Inclusive lower bound (epoch ms) of the calendar-day window. */
  sinceMs: number;
  /** Exclusive upper bound (epoch ms); typically "now". */
  untilMs: number;
  bySource: SourceUsage[];
  total: UsageTotals;
}
