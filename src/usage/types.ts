export type UsageSource = 'claude' | 'codex' | 'pi';

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
   * Cost in USD when the transcript already carries it (Pi). `null` means the
   * cost must be derived from a pricing table; `undefined` is never used.
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
  /** Inclusive lower bound (epoch ms) of the rolling window. */
  sinceMs: number;
  /** Exclusive upper bound (epoch ms); typically "now". */
  untilMs: number;
  bySource: SourceUsage[];
  total: UsageTotals;
}
