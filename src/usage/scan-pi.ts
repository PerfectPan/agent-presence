import { homedir } from 'node:os';
import { join } from 'node:path';

import { forEachJsonl, listJsonlFiles, parseTimestamp } from './read-jsonl.js';
import type { ScanOptions } from './scan-claude.js';
import type { UsageRecord } from './types.js';

export function defaultPiRoot(): string {
  return join(homedir(), '.pi', 'agent', 'sessions');
}

/**
 * Scan Pi transcripts. Pi records full usage AND a resolved cost per assistant
 * message, so we trust the logged cost (display mode) rather than a pricing
 * table — even when that cost is 0 (e.g. a provider Pi has no price for).
 */
export async function scanPi(options: ScanOptions): Promise<UsageRecord[]> {
  const root = options.root ?? defaultPiRoot();
  const files = await listJsonlFiles(root, options.sinceMs);
  const records: UsageRecord[] = [];

  for (const file of files) {
    await forEachJsonl(file, (raw) => {
      const record = extractMessage(raw, options.sinceMs, options.untilMs);
      if (record) {
        records.push(record);
      }
    });
  }
  return records;
}

function extractMessage(raw: unknown, sinceMs: number, untilMs: number): UsageRecord | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (entry.type !== 'message') {
    return null;
  }

  const message = entry.message;
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const msg = message as Record<string, unknown>;
  if (msg.role !== 'assistant') {
    return null;
  }
  const usage = msg.usage;
  if (typeof usage !== 'object' || usage === null) {
    return null;
  }

  const timestamp = parseTimestamp(entry.timestamp);
  if (timestamp === null || timestamp < sinceMs || timestamp >= untilMs) {
    return null;
  }

  const u = usage as Record<string, unknown>;
  const cost = u.cost;
  let costUsd: number | null = null;
  if (typeof cost === 'object' && cost !== null) {
    const total = (cost as Record<string, unknown>).total;
    costUsd = typeof total === 'number' && Number.isFinite(total) ? total : null;
  }

  return {
    source: 'pi',
    model: asString(msg.model) || 'unknown',
    timestamp,
    inputTokens: asNumber(u.input),
    outputTokens: asNumber(u.output),
    cacheWriteTokens: asNumber(u.cacheWrite),
    cacheReadTokens: asNumber(u.cacheRead),
    costUsd
  };
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
