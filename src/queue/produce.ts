import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessLockHeld, type ProcessLockPlatform } from '@rivus/agent-kit-collab/process-lock';
import { hasNodeErrorCode } from '../json-file.js';
import { kitPlatform } from '../kit-platform.js';
import {
  fileExists,
  isDisabled,
  queuePaths,
  randomHex,
  readEpoch,
  readWorkerVersion,
  RECORD_EXTENSION,
  RECORD_VERSION,
  recordFileName,
  systemClock,
  TEMPORARY_PREFIX,
  type QueueClock
} from './files.js';
// Type-only, so erased: the producer runs on the hook path, which must load no schema module and no zod
// (test/hook-graph.test.ts).
import type { QueueRecord } from './schema.js';

type WithoutHeader<T> = T extends unknown ? Omit<T, 'v' | 'id' | 'recordedAt' | 'epoch'> : never;

/** A record without the fields the writer fills in: `v`, `id`, `recordedAt` and `epoch`. */
export type RecordBody = WithoutHeader<QueueRecord>;

export interface WriteRecordOptions {
  /** The number read from `<state>.epoch` before the tombstone check. */
  readonly epoch: number;
  /** The record version to write; this release's by default. */
  readonly version?: number;
  readonly clock?: QueueClock;
  /** The random part of the file name; two random hex bytes by default. */
  readonly randomHex?: () => string;
}

const NAME_ATTEMPTS = 8;

/**
 * Write one record into the queue of `statePath` and return its id. The record goes to a `.tmp-` file first and is
 * renamed to its name, so readers never see a partial record; the rename is the recording point. The
 * pid in the name keeps other processes' names apart, and a name this process already used is skipped, never
 * replaced.
 */
export async function writeRecord(statePath: string, body: RecordBody, options: WriteRecordOptions): Promise<string> {
  const { queueDir } = queuePaths(statePath);
  const recordedAt = (options.clock ?? systemClock).now();
  const nextHex = options.randomHex ?? (() => randomHex(2));
  await mkdir(queueDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
    const name = recordFileName(recordedAt, process.pid, nextHex());
    const id = name.slice(0, -RECORD_EXTENSION.length);
    const record = { v: options.version ?? RECORD_VERSION, id, recordedAt, epoch: options.epoch, ...body };
    const temporary = join(queueDir, `${TEMPORARY_PREFIX}${name}`);
    try {
      // `wx` fails while another write in this process uses the same name, so neither replaces the other's file.
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (hasNodeErrorCode(error, 'EEXIST')) {
        continue;
      }
      // A write that failed after creating the file, for example on a full disk, leaves no partial file behind.
      await rm(temporary, { force: true });
      throw error;
    }

    let renamed = false;
    try {
      const target = join(queueDir, name);
      if (!(await fileExists(target))) {
        await rename(temporary, target);
        renamed = true;
        return id;
      }
    } finally {
      if (!renamed) {
        await rm(temporary, { force: true });
      }
    }
  }
  throw new Error(`no free record name in ${queueDir} after ${NAME_ATTEMPTS} attempts`);
}

/** What a check of the worker lock found: free, or held by a holder whose version `<state>.worker.v` shows. */
export type WorkerLockState = { readonly held: false } | { readonly held: true; readonly version: number };

/**
 * Check, without taking it, whether a process holds the worker lock of `statePath`, and if one does, read the version
 * it wrote, 0 while it has not written one. The answer may be stale when it arrives.
 */
export async function checkWorkerLock(
  statePath: string,
  platform: ProcessLockPlatform = kitPlatform()
): Promise<WorkerLockState> {
  if (!(await isProcessLockHeld(platform, queuePaths(statePath).workerLock))) {
    return { held: false };
  }
  return { held: true, version: await readWorkerVersion(statePath) };
}

/** Whether a producer of record version `version` starts a worker: the lock is free or its holder is older. */
function workerNeeded(lock: WorkerLockState, version: number): boolean {
  return !lock.held || lock.version < version;
}

export interface ProduceOptions {
  /** The record version to write and compare; this release's by default. */
  readonly version?: number;
  readonly clock?: QueueClock;
  /** The platform for the lock check; the shared kit platform by default. */
  readonly platform?: ProcessLockPlatform;
}

export type ProduceOutcome =
  | { readonly status: 'disabled' }
  | { readonly status: 'recorded'; readonly id: string; readonly startWorker: boolean };

/**
 * The producer's steps, taking no lock: read the epoch, check the tombstone, write the record, then
 * check the worker lock. `startWorker` says whether the caller starts a worker. A failed check counts as needing one,
 * since a worker that is not needed leaves on its own. A failed read or write rejects, with no record written.
 */
export async function produceRecord(
  statePath: string,
  body: RecordBody,
  options: ProduceOptions = {}
): Promise<ProduceOutcome> {
  const version = options.version ?? RECORD_VERSION;
  // The epoch comes first: a producer that passed the tombstone check just before `uninstall --all`, then paused, would
  // otherwise read the epoch the next `setup` increased, and appliers would accept its record.
  const epoch = await readEpoch(statePath);
  if (await isDisabled(statePath)) {
    return { status: 'disabled' };
  }
  const id = await writeRecord(statePath, body, { epoch, version, clock: options.clock });
  const startWorker = await checkWorkerLock(statePath, options.platform).then(
    (lock) => workerNeeded(lock, version),
    () => true
  );
  return { status: 'recorded', id, startWorker };
}
