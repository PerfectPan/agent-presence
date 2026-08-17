import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getHomeDir } from './config.js';
import { appendRetainedLogLine } from './log-retention.js';

/**
 * One usage report ingested from a source plugin's hook payload. Sources that
 * cannot (or should not) be scraped from transcripts — dsh, whose plugin
 * reports usage in real time — append events here instead, and their
 * `scanUsage` reads this log back. The log is append-only and size-bounded by
 * the same retention utility as the diagnostic log.
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

export function getUsageEventsPath(): string {
  return process.env.AGENT_PRESENCE_USAGE_EVENTS_FILE ?? join(getHomeDir(), 'usage-events.log');
}

/** Append one usage event. Best-effort: a failed append must never break the hook. */
export async function appendUsageEvent(event: UsageEvent): Promise<void> {
  await appendRetainedLogLine(getUsageEventsPath(), `${JSON.stringify(event)}\n`);
}

/** Read a source's events in `[sinceMs, untilMs)`. Missing/corrupt lines are skipped. */
export async function readUsageEvents(source: string, sinceMs: number, untilMs: number): Promise<UsageEvent[]> {
  let text: string;
  try {
    text = await readFile(getUsageEventsPath(), 'utf8');
  } catch {
    return [];
  }
  const events: UsageEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // compacted log may start mid-line; skip it
    }
    const event = asUsageEvent(parsed);
    if (
      event &&
      event.source === source &&
      event.timestamp >= sinceMs &&
      event.timestamp < untilMs
    ) {
      events.push(event);
    }
  }
  return events;
}

/**
 * Extract a usage event from a hook payload. A plugin reports usage alongside
 * presence as `{ model, usage: { inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens } }`; a payload without it yields `null`.
 */
export function usageEventFromPayload(
  source: string,
  payload: unknown,
  now: number
): UsageEvent | null {
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

function asUsageEvent(value: unknown): UsageEvent | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.source !== 'string' || typeof v.timestamp !== 'number' || !Number.isFinite(v.timestamp)) {
    return null;
  }
  return {
    source: v.source,
    model: typeof v.model === 'string' ? v.model : 'unknown',
    timestamp: v.timestamp,
    inputTokens: asNumber(v.inputTokens),
    outputTokens: asNumber(v.outputTokens),
    cacheWriteTokens: asNumber(v.cacheWriteTokens),
    cacheReadTokens: asNumber(v.cacheReadTokens)
  };
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
