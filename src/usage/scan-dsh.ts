import { readUsageEvents } from '../usage-events.js';
import type { ScanOptions } from './scan-claude.js';
import type { UsageRecord } from './types.js';

/**
 * Scan dsh usage.
 *
 * Unlike the transcript-scraping sources, dsh reports usage in real time: the
 * managed dsh plugin (installed by `agent-presence setup`) includes a `usage`
 * block in each `agent-presence hook --source dsh` payload, which the hook
 * command appends to the usage events log. This scanner reads that log back
 * for the window. dsh records no cost, so `costUsd` is always `null` and the
 * pricing table applies.
 */
export async function scanDsh(options: ScanOptions): Promise<UsageRecord[]> {
  const events = await readUsageEvents('dsh', options.sinceMs, options.untilMs);
  return events.map((event) => ({
    source: 'dsh',
    model: event.model,
    timestamp: event.timestamp,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    cacheReadTokens: event.cacheReadTokens,
    costUsd: null
  }));
}
