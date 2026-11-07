import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  acquireProcessLock,
  isProcessLockHeld,
  type ProcessLock,
  type ProcessLockPlatform
} from '@rivus/agent-kit-collab/process-lock';
import { writeLogEvent } from '../log.js';
import { isPidAlive } from './stop-request.js';
import type { Delay } from './stop-request.js';
import { deleteWorkerVersion, queuePaths, writeWorkerVersion, type QueueClock } from './files.js';
import { readWorkerBeat, writeWorkerBeat } from './worker-beat.js';

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

async function logQuietly(event: Record<string, unknown>): Promise<void> {
  try {
    await writeLogEvent(event);
  } catch {
    // Diagnostic only.
  }
}

/** How long a holder may go without a beat before a takeover judges it stuck: an iteration legitimately spans a
 * provider publish's 30-second timeout, so the bound triples it. */
export const WORKER_STUCK_MS = 90_000;
/** How long a signaled holder may take to leave before it gets SIGKILL. */
export const STUCK_KILL_GRACE_MS = 2_000;

/** Whether the lock's holder is stuck, and if so signals it to leave: only a stale beat by another pid signals. */
async function signalStuckHolder(
  statePath: string,
  options: {
    readonly wall?: QueueClock;
    readonly signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
    readonly isPidAlive?: (pid: number) => boolean;
  }
): Promise<boolean> {
  const beat = await readWorkerBeat(statePath).catch(() => undefined);
  if (beat === undefined || beat.pid === process.pid) {
    return false;
  }
  if ((options.wall ?? { now: () => Date.now() }).now() - beat.at < WORKER_STUCK_MS) {
    return false;
  }
  const signal = options.signal ?? ((pid, name) => process.kill(pid, name));
  const alive = options.isPidAlive ?? isPidAlive;
  try {
    signal(beat.pid, 'SIGTERM');
  } catch {
    // The pid is gone or cannot be signaled; the lock frees on its own or the wait runs out.
    return false;
  }
  setTimeout(() => {
    if (alive(beat.pid)) {
      try {
        signal(beat.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  }, STUCK_KILL_GRACE_MS).unref();
  await logQuietly({ type: 'worker.stuck.signal', pid: beat.pid, beatAt: beat.at });
  return true;
}

/**
 * Wait for the worker lock of `statePath` until `waitMs` of `monotonic` time pass: every `retryMs` it checks the lock
 * without taking it and, when it is free, tries once. When the wait ends with the lock still held, the holder's last
 * beat decides: a holder that has not beaten for `WORKER_STUCK_MS` of wall-clock time is stuck in an iteration, the
 * wait signals it to stop (SIGTERM, then SIGKILL after the grace) and keeps waiting for the lock the kernel frees,
 * so a command recovers without a manual kill; a holder that beats, or one without a readable beat, is left alone and
 * the wait rejects. Never signals this process's own pid, which the in-memory turns already keep out.
 */
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
    /** Signals a stuck holder's pid; `process.kill` by default. */
    readonly signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
    /** Whether a pid is alive; the default checks with kill 0. */
    readonly isPidAlive?: (pid: number) => boolean;
  }
): Promise<ProcessLock> {
  const path = queuePaths(statePath).workerLock;
  const never = new AbortController().signal;
  let deadline = options.monotonic.now() + options.waitMs;
  for (;;) {
    if (!(await isProcessLockHeld(options.platform, path))) {
      const lock = await tryWorkerLock(statePath, options.platform);
      if (lock) {
        return lock;
      }
    }
    if (options.monotonic.now() >= deadline) {
      if (!(await signalStuckHolder(statePath, options))) {
        throw new Error(`timed out waiting for the worker lock: ${path}`);
      }
      // The holder is dying: the kernel frees the lock as it goes, within the grace and the releases.
      deadline = options.monotonic.now() + STUCK_KILL_GRACE_MS * 2;
    }
    await options.delay(options.retryMs, never);
  }
}

/** Write this holder's record version and its first beat, then return the hold; a failed write releases the lock. */
export async function holdWorkerLock(
  statePath: string,
  version: number,
  lock: ProcessLock,
  beat: { readonly pid: number; readonly at: number } = { pid: process.pid, at: Date.now() }
): Promise<WorkerLockHold> {
  try {
    await writeWorkerVersion(statePath, version);
    await writeWorkerBeat(statePath, beat.pid, beat.at);
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
