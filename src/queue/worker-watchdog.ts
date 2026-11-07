import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { queuePaths } from './files.js';
import { STOP_REQUEST_FRESH_MS } from './stop-request.js';

export const WORKER_STUCK_MS = 90_000;

export interface WorkerWatchdog {
  beat(): void;
  stop(): Promise<void>;
}

/**
 * The monitor shares this process's lifetime: it can only terminate itself, never a pid read from disk. The active
 * flag arbitrates release versus termination, so a monitor cannot outlive its lock and kill a later command.
 */
export async function startWorkerWatchdog(
  statePath: string,
  options: { readonly staleMs?: number; readonly pollMs?: number } = {}
): Promise<WorkerWatchdog> {
  const control = new BigInt64Array(new SharedArrayBuffer(16));
  Atomics.store(control, 0, 1n);
  const beat = (): void => {
    Atomics.store(control, 1, process.hrtime.bigint());
  };
  beat();
  const source = import.meta.url.endsWith('.ts');
  const thread = new Worker(
    new URL(source ? './worker-watchdog-thread.ts' : './worker-watchdog-thread.js', import.meta.url),
    {
      workerData: {
        control: control.buffer,
        stopRequestPrefix: queuePaths(statePath).stopRequestPrefix,
        staleMs: options.staleMs ?? WORKER_STUCK_MS,
        pollMs: options.pollMs ?? 2_000,
        requestFreshMs: STOP_REQUEST_FRESH_MS
      },
      execArgv: source ? ['--experimental-transform-types'] : []
    }
  );
  // If a monitor fails, normal cooperative handover still works. Never leave an unhandled Worker error.
  thread.on('error', () => {
    Atomics.store(control, 0, 0n);
  });
  await once(thread, 'online');
  thread.unref();
  // Memory liveness must keep advancing even if writing the diagnostic beat file stalls.
  const heartbeat = setInterval(beat, options.pollMs ?? 2_000).unref();
  let stopped: Promise<void> | undefined;
  return {
    beat,
    stop() {
      clearInterval(heartbeat);
      // A terminating monitor owns the process until it dies. Release must not progress after it won the CAS.
      if (Atomics.compareExchange(control, 0, 1n, 0n) === -1n) {
        return new Promise(() => undefined);
      }
      stopped ??= thread.terminate().then(() => undefined);
      return stopped;
    }
  };
}
