import { homedir } from 'node:os';
import { join } from 'node:path';

import { forEachJsonl, listJsonlFiles, parseTimestamp } from './read-jsonl.js';
import type { ScanOptions } from './scan-claude.js';
import type { UsageRecord } from './types.js';

export function defaultCodexRoot(): string {
  return join(homedir(), '.codex', 'sessions');
}

/**
 * Codex moves older sessions into `archived_sessions`; both must be scanned or
 * longer windows under-count. A `root` override (tests) targets a single dir.
 */
function codexRoots(override?: string): string[] {
  if (override) {
    return [override];
  }
  return [defaultCodexRoot(), join(homedir(), '.codex', 'archived_sessions')];
}

interface Cumulative {
  input: number;
  cached: number;
  output: number;
  total: number;
}

/**
 * Scan Codex transcripts.
 *
 * Codex emits `token_count` events carrying a cumulative `total_token_usage`
 * for the session. Summing the per-event `last_token_usage` over-counts (~1.6x
 * here) because Codex emits overlapping/repeated counts per turn. Instead we
 * diff the monotonic cumulative totals: each positive increment is that turn's
 * real usage, attributed to the event's timestamp (so rolling windows still
 * work), and the increments sum to the session's final cumulative — no double
 * counting. A drop in the cumulative (context compaction/reset) is treated as a
 * fresh increment. Every event is processed to maintain the running baseline,
 * but only in-window increments are emitted.
 */
export async function scanCodex(options: ScanOptions): Promise<UsageRecord[]> {
  const roots = codexRoots(options.root);
  const files = (await Promise.all(roots.map((root) => listJsonlFiles(root, options.sinceMs)))).flat();
  const records: UsageRecord[] = [];

  for (const file of files) {
    let model = '';
    let prev: Cumulative = { input: 0, cached: 0, output: 0, total: 0 };
    const pending: UsageRecord[] = [];

    await forEachJsonl(file, (raw) => {
      if (typeof raw !== 'object' || raw === null) {
        return;
      }
      const entry = raw as Record<string, unknown>;

      const discovered = findModel(entry);
      if (discovered && !model) {
        model = discovered;
      }

      const cumulative = readCumulative(entry);
      if (!cumulative) {
        return;
      }

      // Reset (compaction) detected when the running total drops.
      const base = cumulative.total < prev.total ? { input: 0, cached: 0, output: 0, total: 0 } : prev;
      const dInput = Math.max(0, cumulative.input - base.input);
      const dCached = Math.max(0, cumulative.cached - base.cached);
      const dOutput = Math.max(0, cumulative.output - base.output);
      prev = cumulative;

      if (dInput + dCached + dOutput === 0) {
        return;
      }

      const timestamp = parseTimestamp(entry.timestamp);
      if (timestamp === null || timestamp < options.sinceMs || timestamp >= options.untilMs) {
        return;
      }

      pending.push({
        source: 'codex',
        model: 'unknown',
        timestamp,
        // `input` includes the cached portion; split it so cached reads bill cheaper.
        inputTokens: Math.max(0, dInput - dCached),
        outputTokens: dOutput,
        cacheWriteTokens: 0,
        cacheReadTokens: dCached,
        costUsd: null
      });
    });

    for (const record of pending) {
      record.model = model || 'unknown';
      records.push(record);
    }
  }
  return records;
}

function readCumulative(entry: Record<string, unknown>): Cumulative | null {
  const payload = entry.payload;
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const p = payload as Record<string, unknown>;
  if (p.type !== 'token_count') {
    return null;
  }
  const info = p.info;
  if (typeof info !== 'object' || info === null) {
    return null;
  }
  const total = (info as Record<string, unknown>).total_token_usage;
  if (typeof total !== 'object' || total === null) {
    return null;
  }
  const t = total as Record<string, unknown>;
  return {
    input: asNumber(t.input_tokens),
    cached: asNumber(t.cached_input_tokens),
    output: asNumber(t.output_tokens),
    total: asNumber(t.total_tokens)
  };
}

/** Find a model id on a Codex line, checking common locations. */
function findModel(entry: Record<string, unknown>): string {
  const direct = asString(entry.model);
  if (direct) {
    return direct;
  }
  const payload = entry.payload;
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>;
    const fromPayload = asString(p.model);
    if (fromPayload) {
      return fromPayload;
    }
    const ctx = p.turn_context;
    if (typeof ctx === 'object' && ctx !== null) {
      const fromCtx = asString((ctx as Record<string, unknown>).model);
      if (fromCtx) {
        return fromCtx;
      }
    }
  }
  return '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
