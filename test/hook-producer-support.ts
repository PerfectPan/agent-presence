// Shared by the hook producer tests and the hook event tables: the producer's worker start runs in process, and one
// worker run applies what a hook recorded. Nothing here waits on the wall clock.
import { getStatePath } from '../src/config.js';
import { setHookStartWorkerForTests } from '../src/cli/hook-output.js';
import { WORKER_ROUND_MS, runWorker } from '../src/queue/worker.js';
import { virtualTime } from './queue-support.js';

/** How many times the hooks run so far wanted a worker started. */
export const hookWorkerStarts: { requested: number } = { requested: 0 };

/**
 * Route the producer's worker starts into the counter, so no detached process is spawned; tests drive the worker with
 * `drainQueue` instead. Pair with `restoreHookWorkerStarts` in the test's cleanup.
 */
export function captureHookWorkerStarts(): void {
  hookWorkerStarts.requested = 0;
  setHookStartWorkerForTests(() => {
    hookWorkerStarts.requested += 1;
  });
}

export function restoreHookWorkerStarts(): void {
  setHookStartWorkerForTests(undefined);
}

/**
 * Route the producer's worker starts into the counter and then fail, the way a spawn that cannot start does; tests
 * drive the failure path of a start. Pair with `restoreHookWorkerStarts`.
 */
export function failHookWorkerStarts(): void {
  hookWorkerStarts.requested = 0;
  setHookStartWorkerForTests(() => {
    hookWorkerStarts.requested += 1;
    throw new Error('spawn failed');
  });
}

/**
 * Apply what the hooks recorded, the way a started worker would: one in-process worker run on virtual time with the
 * real owed-work effects, so a boundary refresh scans and the rendered sync publishes through the test file's provider
 * and credential mocks. The idle interval is one round, so the run settles right after its first quiet round.
 */
export async function drainQueue(): Promise<void> {
  const time = virtualTime();
  await runWorker({
    statePath: getStatePath(),
    clock: { now: () => Date.now() },
    monotonic: time.monotonic,
    delay: time.delay,
    startWorker: () => undefined,
    idleMs: WORKER_ROUND_MS
  });
}
