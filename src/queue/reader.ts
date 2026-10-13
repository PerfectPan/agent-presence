import { mkdir, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { hasNodeErrorCode } from '../json-file.js';
import { DAY_MS } from '../time.js';
import {
  parseRecordFileName,
  queuePaths,
  RECORD_VERSION,
  systemClock,
  TEMPORARY_PREFIX,
  type QueueClock
} from './files.js';
import { parseQueueRecord, readRecordVersion, type QueueRecord } from './schema.js';

/** A `.tmp-` file this old belongs to a producer that died while writing it. */
export const TEMPORARY_MAX_AGE_MS = 60 * 60 * 1000;
/** How long a record that failed to parse stays in `failed/`. */
export const FAILED_MAX_AGE_MS = 7 * DAY_MS;

/** A record file in the queue. */
export interface QueueFile {
  /** The file name without its extension. */
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** The recorded time the name leads with. */
  readonly recordedAt: number;
}

export interface QueueListing {
  /** In apply order: by recorded time, then by file name (Plan 0003 3.4). */
  readonly records: QueueFile[];
  /** Paths of `.tmp-` files: records being written, or left by a producer that died while writing. */
  readonly temporary: string[];
}

function byApplyOrder(left: QueueFile, right: QueueFile): number {
  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt - right.recordedAt;
  }
  if (left.name === right.name) {
    return 0;
  }
  return left.name < right.name ? -1 : 1;
}

/**
 * List the queue of `statePath`. Record files are the names a record file name parses from (`files.ts`); `failed/`
 * and every other name are left out, so a file a later release adds to the directory is left alone. A missing queue
 * directory lists as empty.
 */
export async function listQueue(statePath: string): Promise<QueueListing> {
  const { queueDir } = queuePaths(statePath);
  let entries;
  try {
    entries = await readdir(queueDir, { withFileTypes: true });
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return { records: [], temporary: [] };
    }
    throw error;
  }

  const records: QueueFile[] = [];
  const temporary: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.startsWith(TEMPORARY_PREFIX)) {
      temporary.push(join(queueDir, entry.name));
      continue;
    }
    const parsed = parseRecordFileName(entry.name);
    if (parsed) {
      records.push({ ...parsed, name: entry.name, path: join(queueDir, entry.name) });
    }
  }
  return { records: records.sort(byApplyOrder), temporary };
}

/**
 * What reading one record file found:
 * - `record`: parsed, with the id and recorded time its name carries;
 * - `newer`: its `v` is higher than the reader's version; the rest was not parsed, and the file stays in place;
 * - `bad`: not JSON, no valid `v`, invalid for its `kind`, or its id is not its file name; `reason` holds no value;
 * - `missing`: the file was gone when read.
 */
export type QueueRead =
  | { readonly status: 'record'; readonly record: QueueRecord }
  | { readonly status: 'newer'; readonly v: number }
  | { readonly status: 'bad'; readonly reason: string }
  | { readonly status: 'missing' };

/** Read and parse one record file, as a reader of record version `version` (this release's by default). */
export async function readQueueFile(file: QueueFile, version = RECORD_VERSION): Promise<QueueRead> {
  let text: string;
  try {
    text = await readFile(file.path, 'utf8');
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return { status: 'missing' };
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message quotes the text, so it is not passed on.
    return { status: 'bad', reason: 'not JSON' };
  }
  const v = readRecordVersion(raw);
  if (v === undefined) {
    return { status: 'bad', reason: 'v: invalid' };
  }
  if (v > version) {
    return { status: 'newer', v };
  }
  const parsed = parseQueueRecord(raw);
  if (!parsed.ok) {
    return { status: 'bad', reason: parsed.reason };
  }
  if (parsed.record.id !== file.id || parsed.record.recordedAt !== file.recordedAt) {
    return { status: 'bad', reason: 'id: not the file name' };
  }
  return { status: 'record', record: parsed.record };
}

/** Delete a record file; a file already gone is fine. */
export async function deleteQueueFile(file: QueueFile): Promise<void> {
  await rm(file.path, { force: true });
}

/**
 * Move a bad record into `failed/` under its own name, dated now so it stays `FAILED_MAX_AGE_MS` from the move. A file
 * already gone is fine.
 */
export async function moveToFailed(statePath: string, file: QueueFile, clock: QueueClock = systemClock): Promise<void> {
  const { failedDir } = queuePaths(statePath);
  await mkdir(failedDir, { recursive: true, mode: 0o700 });
  const target = join(failedDir, basename(file.path));
  try {
    await rename(file.path, target);
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  const now = new Date(clock.now());
  await utimes(target, now, now);
}

async function removeOlderThan(paths: string[], cutoff: number): Promise<number> {
  let removed = 0;
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && info.mtimeMs < cutoff) {
      await rm(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}

async function listFailed(failedDir: string): Promise<string[]> {
  try {
    const entries = await readdir(failedDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(failedDir, entry.name));
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
}

/**
 * Remove the `.tmp-` files older than `TEMPORARY_MAX_AGE_MS` and the failed records older than `FAILED_MAX_AGE_MS`,
 * judged by modification time against `clock`, and return how many of each went.
 */
export async function removeExpiredFiles(
  statePath: string,
  clock: QueueClock = systemClock
): Promise<{ temporary: number; failed: number }> {
  const now = clock.now();
  const { temporary } = await listQueue(statePath);
  const failed = await listFailed(queuePaths(statePath).failedDir);
  return {
    temporary: await removeOlderThan(temporary, now - TEMPORARY_MAX_AGE_MS),
    failed: await removeOlderThan(failed, now - FAILED_MAX_AGE_MS)
  };
}
