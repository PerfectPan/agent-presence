// Kept free of schemas so the hook path can use `usageEventFromPayload` without loading zod; the usage events log
// and its line schema live in `src/usage-events-log.ts`.

/**
 * One usage report ingested from a source plugin's hook payload. Sources that
 * cannot (or should not) be scraped from transcripts — dsh, whose plugin
 * reports usage in real time — append these to the usage events log instead,
 * and their `scanUsage` reads that log back.
 */
export interface UsageEvent {
  source: string;
  model: string;
  /** Ingestion time (epoch ms) — the moment the hook payload arrived. */
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

function asNumber(value: unknown): number {
  // Ingestion boundary: coerce non-finite and negative values to zero so a
  // malformed plugin payload can't write nonsense into the log.
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Extract a usage event from a hook payload. A plugin reports usage alongside
 * presence as `{ model, usage: { inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens } }`; a payload without it yields `null`.
 */
export function usageEventFromPayload(source: string, payload: unknown, now: number): UsageEvent | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const p = payload as Record<string, unknown>;
  const usage = p.usage;
  if (typeof usage !== 'object' || usage === null) {
    return null;
  }
  const u = usage as Record<string, unknown>;
  const inputTokens = asNumber(u.inputTokens);
  const outputTokens = asNumber(u.outputTokens);
  const cacheReadTokens = asNumber(u.cacheReadTokens);
  const cacheWriteTokens = asNumber(u.cacheWriteTokens);
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) {
    return null;
  }
  const model = typeof p.model === 'string' && p.model ? p.model : 'unknown';
  return {
    source,
    model,
    timestamp: now,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens
  };
}
