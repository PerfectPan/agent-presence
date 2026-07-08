import { type Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { forEachJsonl, parseTimestamp } from './read-jsonl.js';
import type { ScanOptions } from './scan-claude.js';
import type { UsageRecord } from './types.js';

/**
 * Gemini CLI config home. Honours `GEMINI_CLI_HOME` and defaults to `~/.gemini`.
 * Chat transcripts live under `<home>/tmp/<projectHash>/chats/`.
 */
function defaultGeminiRoot(): string {
  const home = process.env.GEMINI_CLI_HOME;
  const base = home && home.trim().length > 0 ? home.trim() : join(homedir(), '.gemini');
  return join(base, 'tmp');
}

/**
 * Scan Gemini CLI transcripts for assistant turns inside the window.
 *
 * Gemini CLI automatically records sessions under `~/.gemini/tmp/<hash>/chats/`.
 * The current format is JSONL: a metadata line, then per-message records
 * `{ id, timestamp (ISO), type: 'user' | 'gemini', model?, tokens? }`, where an
 * assistant (`gemini`) message carries
 * `tokens: { input, output, cached, thoughts?, tool?, total }`. A legacy
 * single-object `.json` form (`{ ..., messages: [...] }`) also exists.
 *
 * Gemini records tokens but no cost, so records reprice via the pricing table
 * (like Codex). The CLI re-appends the same message id when it attaches tokens,
 * so we de-duplicate by `id`, keeping the largest-total occurrence — the final,
 * token-bearing copy — rather than double-counting.
 */
export async function scanGemini(options: ScanOptions): Promise<UsageRecord[]> {
  const root = options.root ?? defaultGeminiRoot();
  const files = await listChatFiles(root, options.sinceMs);
  const deduped = new Map<string, UsageRecord>();
  const unkeyed: UsageRecord[] = [];

  const consider = (record: UsageRecord | null, id: string | undefined): void => {
    if (!record) {
      return;
    }
    if (!id) {
      unkeyed.push(record);
      return;
    }
    const existing = deduped.get(id);
    if (!existing || total(record) > total(existing)) {
      deduped.set(id, record);
    }
  };

  for (const file of files) {
    if (file.endsWith('.jsonl')) {
      await forEachJsonl(file, (raw) => {
        const parsed = extractRecord(raw, options.sinceMs, options.untilMs);
        consider(parsed?.record ?? null, parsed?.id);
      });
    } else {
      for (const raw of await readLegacyMessages(file)) {
        const parsed = extractRecord(raw, options.sinceMs, options.untilMs);
        consider(parsed?.record ?? null, parsed?.id);
      }
    }
  }

  return [...deduped.values(), ...unkeyed];
}

// Ordering within a source is immaterial: `summarise` aggregates a source's
// records into one row and only the per-source total is surfaced, so emitting
// deduped (id-bearing) records before any unkeyed ones is fine. Every real
// gemini message carries an id, so `unkeyed` is effectively always empty.

function total(record: UsageRecord): number {
  return record.inputTokens + record.outputTokens + record.cacheWriteTokens + record.cacheReadTokens;
}

/** Recursively collect `*.jsonl` (current) and `*.json` (legacy) chat files under `root`. */
async function listChatFiles(root: string, sinceMs: number): Promise<string[]> {
  const found: string[] = [];
  await walk(root, sinceMs, found);
  return found;
}

async function walk(dir: string, sinceMs: number, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, sinceMs, out);
      continue;
    }
    if (!entry.isFile() || (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.json'))) {
      continue;
    }
    try {
      const info = await stat(full);
      if (info.mtimeMs >= sinceMs) {
        out.push(full);
      }
    } catch {
      // racing deletion / permission — skip this file.
    }
  }
}

/** Read a legacy single-object session file and return its `messages` array. */
async function readLegacyMessages(file: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const messages = (parsed as Record<string, unknown>).messages;
  return Array.isArray(messages) ? messages : [];
}

function extractRecord(
  raw: unknown,
  sinceMs: number,
  untilMs: number
): { record: UsageRecord; id: string | undefined } | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const message = raw as Record<string, unknown>;
  if (message.type !== 'gemini') {
    return null;
  }

  const tokens = message.tokens;
  if (typeof tokens !== 'object' || tokens === null) {
    return null;
  }
  const t = tokens as Record<string, unknown>;

  const timestamp = parseTimestamp(message.timestamp);
  if (timestamp === null || timestamp < sinceMs || timestamp >= untilMs) {
    return null;
  }

  const input = asNumber(t.input);
  const cached = asNumber(t.cached);

  return {
    record: {
      source: 'gemini',
      model: asString(message.model) || 'unknown',
      timestamp,
      // Gemini's `input` (promptTokenCount) already includes cached tokens, so
      // split cached out to bill it at the cheaper cache-read rate (like Codex).
      inputTokens: Math.max(0, input - cached),
      // Thinking tokens are billed as output.
      outputTokens: asNumber(t.output) + asNumber(t.thoughts),
      cacheWriteTokens: 0,
      cacheReadTokens: cached,
      // `tokens.tool` (toolUsePromptTokenCount) is intentionally not mapped: it
      // has no distinct pricing bucket and is a small, usually-zero component,
      // so the four buckets can slightly undercount Gemini's own `tokens.total`
      // for tool-heavy turns. Documented tradeoff (see rfcs/source-usage.md).
      costUsd: null
    },
    id: asString(message.id) || undefined
  };
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
