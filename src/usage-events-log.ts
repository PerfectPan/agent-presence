import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/mini';
// Imported by name: called as `z.catch(...)`, the promise lint rule mistakes it for `Promise.prototype.catch`.
import { catch as catchInvalid } from 'zod/mini';

import { getHomeDir } from './config.js';
import { appendRetainedLogLine } from './log-retention.js';
import type { UsageEvent } from './usage-events.js';
import { forEachJsonl } from './usage/read-jsonl.js';

/**
 * The usage events log: sources that report usage in their hook payloads (dsh) append their usage events here, and
 * their `scanUsage` reads them back. It is append-only and size-bounded by the same retention as the diagnostic log.
 */
export function getUsageEventsPath(): string {
  return process.env.AGENT_PRESENCE_USAGE_EVENTS_FILE ?? join(getHomeDir(), 'usage-events.log');
}

/**
 * Append one usage event, with the id of the record it came from when there is one, so a reader counts a line that an
 * interrupted append repeated only once. Waits for the log lock until `signal` aborts (2.5 seconds without one) and
 * resolves whether the line was written.
 */
export async function appendUsageEvent(
  event: UsageEvent,
  options: { id?: string; signal?: AbortSignal } = {}
): Promise<boolean> {
  const line = options.id === undefined ? event : { ...event, id: options.id };
  return appendRetainedLogLine(getUsageEventsPath(), `${JSON.stringify(line)}\n`, { signal: options.signal });
}

// A line is untrusted: a line without a source or timestamp is skipped, a token count that is not a positive number
// counts as 0, a model that is not a string as `unknown`, and an id that is not a string as no id.
const tokenCount = catchInvalid(z.number().check(z.positive()), 0);
const usageLineSchema = z.object({
  id: catchInvalid(z.optional(z.string()), undefined),
  source: z.string(),
  model: catchInvalid(z.string(), 'unknown'),
  timestamp: z.number(),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  cacheReadTokens: tokenCount
});

/** Read a source's events in `[sinceMs, untilMs)`. Corrupt lines and lines repeating an earlier id are skipped. */
export async function readUsageEvents(source: string, sinceMs: number, untilMs: number): Promise<UsageEvent[]> {
  const path = getUsageEventsPath();
  // The log is append-only with ingestion timestamps, so an mtime older than
  // the window means zero events in range — skip the read entirely.
  try {
    const info = await stat(path);
    if (info.mtimeMs < sinceMs) {
      return [];
    }
  } catch {
    return [];
  }
  const events: UsageEvent[] = [];
  const seenIds = new Set<string>();
  await forEachJsonl(path, (record) => {
    const parsed = usageLineSchema.safeParse(record);
    if (!parsed.success) {
      return;
    }
    const { id, ...event } = parsed.data;
    if (id !== undefined) {
      if (seenIds.has(id)) {
        return;
      }
      seenIds.add(id);
    }
    if (event.source === source && event.timestamp >= sinceMs && event.timestamp < untilMs) {
      events.push(event);
    }
  });
  return events;
}
