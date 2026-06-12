import { homedir } from 'node:os';
import { join } from 'node:path';

import { forEachJsonl, listJsonlFiles, parseTimestamp } from './read-jsonl.js';
import type { UsageRecord } from './types.js';

export interface ScanOptions {
  /** Override the transcript root (mainly for tests). */
  root?: string;
  sinceMs: number;
  untilMs: number;
}

/** Default Claude transcript root, honouring `CLAUDE_CONFIG_DIR` like ccusage. */
export function defaultClaudeRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir && configDir.trim().length > 0) {
    return join(configDir.trim(), 'projects');
  }
  return join(homedir(), '.claude', 'projects');
}

/** Claude marks internal (non-billable) turns with this model id; ccusage skips them. */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Scan Claude Code transcripts for assistant turns inside the window.
 *
 * De-duplication matches ccusage: entries sharing `message.id` + `requestId`
 * are the same turn (resume/fork copies it verbatim, and streaming rewrites it
 * with growing `output_tokens`). We keep the occurrence with the largest total
 * — i.e. the final, complete turn — rather than the first, which would
 * under-count output for streamed turns. Synthetic turns are excluded.
 */
export async function scanClaude(options: ScanOptions): Promise<UsageRecord[]> {
  const root = options.root ?? defaultClaudeRoot();
  const files = await listJsonlFiles(root, options.sinceMs);
  const deduped = new Map<string, UsageRecord>();
  const unkeyed: UsageRecord[] = [];

  for (const file of files) {
    await forEachJsonl(file, (raw) => {
      const parsed = extractRecord(raw, options.sinceMs, options.untilMs);
      if (!parsed) {
        return;
      }
      const { record, dedupKey } = parsed;
      if (dedupKey === null) {
        unkeyed.push(record);
        return;
      }
      const existing = deduped.get(dedupKey);
      if (!existing || total(record) > total(existing)) {
        deduped.set(dedupKey, record);
      }
    });
  }
  return [...deduped.values(), ...unkeyed];
}

function total(record: UsageRecord): number {
  return record.inputTokens + record.outputTokens + record.cacheWriteTokens + record.cacheReadTokens;
}

function extractRecord(
  raw: unknown,
  sinceMs: number,
  untilMs: number
): { record: UsageRecord; dedupKey: string | null } | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (entry.type !== 'assistant') {
    return null;
  }

  const message = entry.message;
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const msg = message as Record<string, unknown>;
  const usage = msg.usage;
  if (typeof usage !== 'object' || usage === null) {
    return null;
  }

  const model = asString(msg.model) || 'unknown';
  if (model === SYNTHETIC_MODEL) {
    return null;
  }

  const timestamp = parseTimestamp(entry.timestamp);
  if (timestamp === null || timestamp < sinceMs || timestamp >= untilMs) {
    return null;
  }

  const id = asString(msg.id);
  const requestId = asString(entry.requestId);
  const dedupKey = id || requestId ? `${id}:${requestId}` : null;

  const u = usage as Record<string, unknown>;
  return {
    record: {
      source: 'claude',
      model,
      timestamp,
      inputTokens: asNumber(u.input_tokens),
      outputTokens: asNumber(u.output_tokens),
      cacheWriteTokens: asNumber(u.cache_creation_input_tokens),
      cacheReadTokens: asNumber(u.cache_read_input_tokens),
      costUsd: null
    },
    dedupKey
  };
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
