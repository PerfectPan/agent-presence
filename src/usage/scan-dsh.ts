import { readUsageEvents } from '../usage-events-log.js';
import type { ScanWindow, UsageRecord } from './types.js';

/**
 * Scan dsh usage.
 *
 * Unlike the kit-decoded transcript sources, dsh reports usage in real time:
 * the managed dsh plugin (installed by `agent-presence setup`) includes a
 * `usage` block in each `agent-presence hook --source dsh` payload, which the
 * hook command appends to the usage events log. This scanner reads that log
 * back for the window. dsh records no cost, so `costUsd` is always `null` and
 * the pricing table applies at the totals boundary.
 */
export async function scanDsh(options: ScanWindow): Promise<UsageRecord[]> {
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
