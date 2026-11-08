import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  acquireProcessLock,
  isProcessLockHeld,
  type ProcessLock,
  type ProcessLockPlatform
} from '@rivus/agent-kit-collab/process-lock';
import type { Delay } from './stop-request.js';
import { deleteWorkerVersion, queuePaths, writeWorkerVersion, type QueueClock } from './files.js';
import { WORKER_STUCK_MS } from './worker-watchdog.js';
import { holdWorkerBeat, readWorkerBeat, workerBeatPath } from './worker-beat.js';

/** The worker lock, held by the applier: a worker or a command that took over. */
export interface WorkerLockHold {
  /** Delete `<state>.worker.v`, then release the lock: steps 1 and 2 of leaving. Later calls do nothing. */
  release(): Promise<void>;
}

/**
 * Take the worker lock of `statePath` once, without waiting, and return it, or `undefined` when another process or
 * acquisition holds it. A try against a held lock costs about 125 ms of settling, so callers check first.
 */
export async function tryWorkerLock(
  statePath: string,
  platform: ProcessLockPlatform
): Promise<ProcessLock | undefined> {
  const path = queuePaths(statePath).workerLock;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const result = await acquireProcessLock(platform, path, { wait: false });
  return result.ok ? result.value : undefined;
}

/** A stale beat only extends a command's wait; it never authorizes signaling a pid. */
export const WORKER_RECOVERY_WAIT_MS = 4_000;

/** Wait once, then allow a stale worker's own watchdog one bounded interval to terminate itself. */
export async function waitForWorkerLock(
  statePath: string,
  options: {
    readonly platform: ProcessLockPlatform;
    readonly monotonic: QueueClock;
    readonly delay: Delay;
    readonly waitMs: number;
    readonly retryMs: number;
    /** Wall clock for the beat's age; the system clock by default. */
    readonly wall?: QueueClock;
  }
): Promise<ProcessLock> {
  const path = queuePaths(statePath).workerLock;
  const never = new AbortController().signal;
  let deadline = options.monotonic.now() + options.waitMs;
  let recovering = false;
  for (;;) {
    if (!(await isProcessLockHeld(options.platform, path))) {
      const lock = await tryWorkerLock(statePath, options.platform);
      if (lock) {
        return lock;
      }
    }
    if (options.monotonic.now() >= deadline) {
      const beat = recovering ? undefined : await readWorkerBeat(statePath);
      if (!beat || (options.wall?.now() ?? Date.now()) - beat.at < WORKER_STUCK_MS) {
        throw new Error(`timed out waiting for the worker lock: ${path}`);
      }
      recovering = true;
      deadline = options.monotonic.now() + WORKER_RECOVERY_WAIT_MS;
    }
    await options.delay(options.retryMs, never);
  }
}

/** Publish the holder version; only workers opt into heartbeats, commands clear any preceding beat. */
export async function holdWorkerLock(
  statePath: string,
  version: number,
  lock: ProcessLock,
  beat?: { readonly clock: QueueClock; readonly delay?: Delay; readonly watchdog?: boolean }
): Promise<WorkerLockHold> {
  let stopBeat: (() => Promise<void>) | undefined;
  const clearMetadata = async (): Promise<void> => {
    try {
      await rm(workerBeatPath(statePath), { force: true });
    } finally {
      await deleteWorkerVersion(statePath);
    }
  };
  try {
    await rm(workerBeatPath(statePath), { force: true });
    await writeWorkerVersion(statePath, version);
    if (beat?.watchdog) {
      stopBeat = await holdWorkerBeat(statePath, beat.clock, beat.delay);
    }
  } catch (error) {
    try {
      await clearMetadata();
    } finally {
      await lock.release();
    }
    throw error;
  }
  let released: Promise<void> | undefined;
  return {
    release() {
      released ??= (async () => {
        try {
          await stopBeat?.();
          await clearMetadata();
        } finally {
          await lock.release();
        }
      })();
      return released;
    }
  };
}
