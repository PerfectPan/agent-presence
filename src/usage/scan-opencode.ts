import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ScanOptions } from './scan-claude.js';
import type { UsageRecord } from './types.js';

/**
 * opencode data home. Honours `XDG_DATA_HOME` (opencode follows the XDG base-dir
 * spec) and defaults to `~/.local/share`. The transcript store lives under
 * `<dataHome>/opencode`.
 */
function defaultOpenCodeDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg.trim() : join(homedir(), '.local', 'share');
  return join(base, 'opencode');
}

/**
 * Scan opencode transcripts for assistant messages inside the window.
 *
 * opencode (>=1.2) records usage in a SQLite DB at `<dir>/opencode.db`: the
 * `message` table has one row per message with a `data` JSON column carrying,
 * for assistant messages, `{ role, tokens:{input,output,reasoning,cache:{read,write}},
 * cost, modelID, time:{created,completed} }`. opencode logs a real per-message
 * cost, so we trust it (like Pi) rather than repricing — even a `0` cost.
 *
 * Preference order, all read-only and fail-soft:
 * 1. SQLite via node's builtin `node:sqlite` (Node >=22). Imported dynamically
 *    so a Node <22 runtime — `engines.node` allows `>=20` — never fails at load.
 * 2. Legacy (<1.2) JSON at `<dir>/storage/message/{sessionId}/*.json`, same
 *    per-message shape.
 * 3. Nothing present -> `[]`.
 */
export async function scanOpenCode(options: ScanOptions): Promise<UsageRecord[]> {
  const dir = options.root ?? defaultOpenCodeDir();

  const fromDb = await scanSqlite(join(dir, 'opencode.db'), options);
  if (fromDb !== null) {
    return fromDb;
  }
  return scanLegacyJson(join(dir, 'storage', 'message'), options);
}

/**
 * Read the SQLite store. Returns `null` (not `[]`) when the DB is unusable — a
 * missing file, or `node:sqlite` being unavailable — so the caller falls back to
 * the legacy JSON store. Returns `[]` only when the DB opened but held no
 * in-window rows.
 */
async function scanSqlite(dbPath: string, options: ScanOptions): Promise<UsageRecord[] | null> {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null; // Node <22 or sqlite disabled — try the legacy JSON store.
  }

  let db: import('node:sqlite').DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null; // No DB file (or unreadable) — try the legacy JSON store.
  }

  try {
    // Pre-filter by the row's create time; the precise window check uses the
    // message's own completion time below. A turn created just before the
    // window's lower bound but completing just inside it is dropped here — a
    // narrow, deliberate under-count at the window edge, matching the mtime
    // pre-filter the JSONL scanners already accept as a scan-cost tradeoff.
    const rows = db
      .prepare('SELECT time_created, data FROM message WHERE time_created >= ?')
      .all(options.sinceMs) as Array<{ time_created: number; data: string }>;
    const records: UsageRecord[] = [];
    for (const row of rows) {
      const record = extractRecord(row.data, row.time_created, options.sinceMs, options.untilMs);
      if (record) {
        records.push(record);
      }
    }
    return records;
  } catch {
    return null; // Schema drift or a read error — fall back rather than throw.
  } finally {
    try {
      db.close();
    } catch {
      // already closed / never opened — ignore.
    }
  }
}

/** Legacy layout: `<messageRoot>/{sessionId}/*.json`, one message object per file. */
async function scanLegacyJson(messageRoot: string, options: ScanOptions): Promise<UsageRecord[]> {
  const files = await listJsonFiles(messageRoot);
  const records: UsageRecord[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue; // racing deletion / permission — skip.
    }
    const record = extractRecord(raw, undefined, options.sinceMs, options.untilMs);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

async function listJsonFiles(root: string): Promise<string[]> {
  let sessions: string[];
  try {
    sessions = await readdir(root);
  } catch {
    return []; // No legacy store — nothing to scan.
  }
  const found: string[] = [];
  for (const session of sessions) {
    const sessionDir = join(root, session);
    let names: string[];
    try {
      const info = await stat(sessionDir);
      if (!info.isDirectory()) {
        continue;
      }
      names = await readdir(sessionDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.json')) {
        found.push(join(sessionDir, name));
      }
    }
  }
  return found;
}

/**
 * Turn one message `data` blob into a usage record, or `null` when it is not a
 * billable assistant message or falls outside the window. `rowCreatedMs` is the
 * SQLite `time_created` fallback when the JSON carries no completion time.
 */
function extractRecord(
  data: string,
  rowCreatedMs: number | undefined,
  sinceMs: number,
  untilMs: number
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const message = parsed as Record<string, unknown>;
  if (message.role !== 'assistant') {
    return null;
  }

  const tokens = message.tokens;
  if (typeof tokens !== 'object' || tokens === null) {
    return null;
  }
  const t = tokens as Record<string, unknown>;
  const cache = typeof t.cache === 'object' && t.cache !== null ? (t.cache as Record<string, unknown>) : {};

  const timestamp = messageTimestamp(message.time, rowCreatedMs);
  if (timestamp === null || timestamp < sinceMs || timestamp >= untilMs) {
    return null;
  }

  const cost = asNumber(message.cost, null);

  return {
    source: 'opencode',
    model: asString(message.modelID) || 'unknown',
    timestamp,
    inputTokens: asNumber(t.input),
    // opencode bills reasoning as output; folding it in keeps our four-bucket
    // total equal to opencode's own `tokens.total`.
    outputTokens: asNumber(t.output) + asNumber(t.reasoning),
    cacheWriteTokens: asNumber(cache.write),
    cacheReadTokens: asNumber(cache.read),
    // opencode records a resolved cost, so we trust it (like Pi), including 0.
    costUsd: cost
  };
}

/** Prefer the message's completion time, then its create time, then the DB row's. */
function messageTimestamp(time: unknown, rowCreatedMs: number | undefined): number | null {
  if (typeof time === 'object' && time !== null) {
    const record = time as Record<string, unknown>;
    const completed = asNumber(record.completed, null);
    if (completed !== null) {
      return completed;
    }
    const created = asNumber(record.created, null);
    if (created !== null) {
      return created;
    }
  }
  return rowCreatedMs ?? null;
}

function asNumber(value: unknown): number;
function asNumber(value: unknown, fallback: null): number | null;
function asNumber(value: unknown, fallback: number | null = 0): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
