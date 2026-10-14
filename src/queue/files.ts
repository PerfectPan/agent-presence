import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hasNodeErrorCode } from '../json-file.js';

// Processes of two releases with the queue read each other's files (Plan 0003 3.12), so every name and text format in
// this module is fixed for all of them: a later release may add files, never rename one or change what it holds. The
// hook reaches this module through the producer, so it stays free of schemas: the numbers are decimal text and the
// tombstone is an existence check.

/** The record version this release writes and applies up to (Plan 0003 3.2). */
export const RECORD_VERSION = 1;

/** Wall-clock milliseconds; tests pass their own. */
export interface QueueClock {
  now(): number;
}

export const systemClock: QueueClock = { now: () => Date.now() };

/** The files next to a state file that the queue uses. */
export interface QueuePaths {
  /** The records, one file each. */
  readonly queueDir: string;
  /** Records an applier could not parse, kept for a while. */
  readonly failedDir: string;
  /** Decimal text: the epoch producers copy into their records. */
  readonly epoch: string;
  /** The tombstone; only whether it exists matters. */
  readonly disabled: string;
  /** The kit's process lock that the applier, a worker or a command that took over, holds. */
  readonly workerLock: string;
  /** Decimal text: the record version of the process that holds the worker lock. */
  readonly workerVersion: string;
  /** Followed by a token: the stop request files of commands waiting for the worker lock. */
  readonly stopRequestPrefix: string;
}

export function queuePaths(statePath: string): QueuePaths {
  const queueDir = `${statePath}.queue`;
  return {
    queueDir,
    failedDir: join(queueDir, 'failed'),
    epoch: `${statePath}.epoch`,
    disabled: `${statePath}.disabled`,
    workerLock: `${statePath}.worker.lock.db`,
    workerVersion: `${statePath}.worker.v`,
    stopRequestPrefix: `${statePath}.worker.stop.`
  };
}

/** A record is written under this prefix and then renamed, so a reader never sees a partial record. */
export const TEMPORARY_PREFIX = '.tmp-';

export const RECORD_EXTENSION = '.json';
// Thirteen digits hold every millisecond timestamp until the year 2286, so names sort as their recorded times do.
const RECORDED_AT_DIGITS = 13;
const RECORD_FILE_NAME = /^(\d{13})-.+\.json$/;

/** `<recordedAt, 13 digits>-<pid>-<random hex>.json`; the record id is the name without the extension. */
export function recordFileName(recordedAt: number, pid: number, randomHex: string): string {
  if (!Number.isSafeInteger(recordedAt) || recordedAt < 0 || recordedAt >= 10 ** RECORDED_AT_DIGITS) {
    throw new RangeError(`recorded time does not fit a record file name: ${recordedAt}`);
  }
  return `${String(recordedAt).padStart(RECORDED_AT_DIGITS, '0')}-${pid}-${randomHex}${RECORD_EXTENSION}`;
}

/** The id and recorded time a record file name carries, or `undefined` for a name that is not a record's. */
export function parseRecordFileName(name: string): { id: string; recordedAt: number } | undefined {
  const match = RECORD_FILE_NAME.exec(name);
  if (!match?.[1]) {
    return undefined;
  }
  return { id: name.slice(0, -RECORD_EXTENSION.length), recordedAt: Number(match[1]) };
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

const DECIMAL = /^\d+$/;

/** A missing file, or text that is not a non-negative integer, reads as 0. */
async function readDecimalFile(path: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return 0;
    }
    throw error;
  }
  const trimmed = text.trim();
  const value = Number(trimmed);
  return DECIMAL.test(trimmed) && Number.isSafeInteger(value) ? value : 0;
}

/** Written to a temporary file and renamed, so a reader sees the old number or the new one. */
async function writeDecimalFile(path: string, value: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomHex(4)}.tmp`;
  try {
    await writeFile(temporary, `${value}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

/** The epoch producers copy into their records and appliers compare them with; 0 before the first increase. */
export function readEpoch(statePath: string): Promise<number> {
  return readDecimalFile(queuePaths(statePath).epoch);
}

/** Increase the epoch by one and return it; `setup` does this when it removes a tombstone (Plan 0003 3.8). */
export async function increaseEpoch(statePath: string): Promise<number> {
  const next = (await readEpoch(statePath)) + 1;
  await writeDecimalFile(queuePaths(statePath).epoch, next);
  return next;
}

/** Whether the tombstone exists: producers record nothing, workers exit, and commands change nothing. */
export function isDisabled(statePath: string): Promise<boolean> {
  return fileExists(queuePaths(statePath).disabled);
}

export async function writeTombstone(statePath: string): Promise<void> {
  const { disabled } = queuePaths(statePath);
  await mkdir(dirname(disabled), { recursive: true, mode: 0o700 });
  await writeFile(disabled, '', { mode: 0o600 });
}

export async function removeTombstone(statePath: string): Promise<void> {
  await rm(queuePaths(statePath).disabled, { force: true });
}

/** The record version the worker-lock holder wrote; 0 while none is written. */
export function readWorkerVersion(statePath: string): Promise<number> {
  return readDecimalFile(queuePaths(statePath).workerVersion);
}

/** Every holder writes its version right after it takes the worker lock (Plan 0003 3.3). */
export async function writeWorkerVersion(statePath: string, version: number): Promise<void> {
  await writeDecimalFile(queuePaths(statePath).workerVersion, version);
}

/** Every holder deletes its version right before it releases the worker lock (Plan 0003 3.6). */
export async function deleteWorkerVersion(statePath: string): Promise<void> {
  await rm(queuePaths(statePath).workerVersion, { force: true });
}
