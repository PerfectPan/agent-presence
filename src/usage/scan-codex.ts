import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

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

const REPLAY_PREFIX_BYTES = 16 * 1024;

/**
 * Scan Codex transcripts.
 *
 * Codex emits `token_count` events with both a per-turn `last_token_usage` and a
 * cumulative `total_token_usage`. Forked/subagent sessions begin by replaying
 * the parent's full event history at one timestamp second; those replayed
 * events establish the child's cumulative baseline but are not new usage.
 * Detect and skip that prefix using the same markers and timestamp rule as
 * ccusage, then prefer `last_token_usage` for real events. Older logs without
 * it fall back to a saturating diff of cumulative totals.
 */
export async function scanCodex(options: ScanOptions): Promise<UsageRecord[]> {
  const roots = codexRoots(options.root);
  const files = (await Promise.all(roots.map((root) => listJsonlFiles(root, options.sinceMs)))).flat();
  const records: UsageRecord[] = [];

  for (const file of files) {
    let model = '';
    let prev: Cumulative = { input: 0, cached: 0, output: 0, total: 0 };
    const replaySecond = await detectReplaySecond(file);
    let skipReplay = replaySecond !== null;

    await forEachJsonl(file, (raw) => {
      if (typeof raw !== 'object' || raw === null) {
        return;
      }
      const entry = raw as Record<string, unknown>;

      const discovered = findModel(entry);
      if (discovered) {
        model = discovered;
      }

      const cumulative = readCumulative(entry);
      if (!cumulative) {
        return;
      }

      const timestamp = parseTimestamp(entry.timestamp);
      if (skipReplay) {
        prev = cumulative;
        if (timestampSecond(entry.timestamp) === replaySecond) {
          return;
        }
        skipReplay = false;
      }

      const usage = readLastUsage(entry) ?? subtractCumulative(cumulative, prev);
      prev = cumulative;

      if (usage.input + usage.cached + usage.output === 0) {
        return;
      }

      if (timestamp === null || timestamp < options.sinceMs || timestamp >= options.untilMs) {
        return;
      }

      const cached = Math.min(usage.cached, usage.input);
      records.push({
        source: 'codex',
        model: model || 'unknown',
        timestamp,
        // `input` includes the cached portion; split it so cached reads bill cheaper.
        inputTokens: Math.max(0, usage.input - cached),
        outputTokens: usage.output,
        cacheWriteTokens: 0,
        cacheReadTokens: cached,
        costUsd: null
      });
    });
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
  return readUsageObject((info as Record<string, unknown>).total_token_usage);
}

function readLastUsage(entry: Record<string, unknown>): Cumulative | null {
  const payload = entry.payload;
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const info = (payload as Record<string, unknown>).info;
  if (typeof info !== 'object' || info === null) {
    return null;
  }
  return readUsageObject((info as Record<string, unknown>).last_token_usage);
}

function readUsageObject(value: unknown): Cumulative | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const t = value as Record<string, unknown>;
  return {
    input: asNumber(t.input_tokens),
    cached: asNumber(t.cached_input_tokens),
    output: asNumber(t.output_tokens),
    total: asNumber(t.total_tokens)
  };
}

function subtractCumulative(current: Cumulative, previous: Cumulative): Cumulative {
  return {
    input: Math.max(0, current.input - previous.input),
    cached: Math.max(0, current.cached - previous.cached),
    output: Math.max(0, current.output - previous.output),
    total: Math.max(0, current.total - previous.total)
  };
}

/**
 * Return the timestamp second occupied by a replay prefix, or `null` for a
 * normal session. Codex marks replay-capable files in `session_meta`; a real
 * replay has its first two token events collapsed into the same second.
 */
async function detectReplaySecond(file: string): Promise<string | null> {
  if (!(await hasReplayMarker(file))) {
    return null;
  }

  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(file, { encoding: 'utf8' });
  } catch {
    return null;
  }

  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let firstSecond: string | null = null;
  try {
    for await (const line of lines) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof raw !== 'object' || raw === null || !readCumulative(raw as Record<string, unknown>)) {
        continue;
      }
      const second = timestampSecond((raw as Record<string, unknown>).timestamp);
      if (second === null) {
        continue;
      }
      if (firstSecond === null) {
        firstSecond = second;
        continue;
      }
      return firstSecond === second ? firstSecond : null;
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

async function hasReplayMarker(file: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(REPLAY_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString('utf8');
    return prefix.includes('"thread_spawn"') || prefix.includes('"forked_from_id"');
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function timestampSecond(value: unknown): string | null {
  const timestamp = parseTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString().slice(0, 19);
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
    const info = p.info;
    if (typeof info === 'object' && info !== null) {
      const fromInfo = asString((info as Record<string, unknown>).model);
      if (fromInfo) {
        return fromInfo;
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
