import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  acquireProcessLock,
  isProcessLockHeld,
  type ProcessLock,
  type ProcessLockPlatform
} from '@rivus/agent-kit-collab/process-lock';
import type { Delay } from './stop-request.js';
import { deleteWorkerVersion, queuePaths, writeWorkerVersion, type QueueClock } from './files.js';

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

/**
 * Wait for the worker lock of `statePath` until `waitMs` of `monotonic` time pass: every `retryMs` it checks the lock
 * without taking it and, when it is free, tries once. Rejects when the wait ends without the lock.
 */
export async function waitForWorkerLock(
  statePath: string,
  options: {
    readonly platform: ProcessLockPlatform;
    readonly monotonic: QueueClock;
    readonly delay: Delay;
    readonly waitMs: number;
    readonly retryMs: number;
  }
): Promise<ProcessLock> {
  const path = queuePaths(statePath).workerLock;
  const deadline = options.monotonic.now() + options.waitMs;
  const never = new AbortController().signal;
  for (;;) {
    if (!(await isProcessLockHeld(options.platform, path))) {
      const lock = await tryWorkerLock(statePath, options.platform);
      if (lock) {
        return lock;
      }
    }
    if (options.monotonic.now() >= deadline) {
      throw new Error(`timed out waiting for the worker lock: ${path}`);
    }
    await options.delay(options.retryMs, never);
  }
}

/** Write this holder's record version to `<state>.worker.v` and return the hold; a failed write releases the lock. */
export async function holdWorkerLock(statePath: string, version: number, lock: ProcessLock): Promise<WorkerLockHold> {
  try {
    await writeWorkerVersion(statePath, version);
  } catch (error) {
    await lock.release();
    throw error;
  }
  let released: Promise<void> | undefined;
  return {
    release() {
      released ??= (async () => {
        try {
          await deleteWorkerVersion(statePath);
        } finally {
          await lock.release();
        }
      })();
      return released;
    }
  };
}
