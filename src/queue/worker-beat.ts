import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as z from 'zod/mini';
import { randomHex, queuePaths, type QueueClock } from './files.js';
import { startWorkerWatchdog } from './worker-watchdog.js';
import type { Delay } from './stop-request.js';

// Version 1 identified only a pid. It cannot distinguish a reused pid or a different lock acquisition.
const beatSchema = z.object({
  v: z.literal(2),
  recovery: z.literal('self-watchdog'),
  pid: z.number().check(z.int(), z.minimum(1)),
  at: z.number().check(z.minimum(0))
});

export type WorkerBeat = z.infer<typeof beatSchema>;
export const WORKER_BEAT_MS = 2_000;

export function workerBeatPath(statePath: string): string {
  return `${queuePaths(statePath).workerVersion}.beat`;
}

/** Unreadable, legacy and unknown beats never authorize recovery. */
export async function readWorkerBeat(statePath: string): Promise<WorkerBeat | undefined> {
  try {
    const parsed = beatSchema.safeParse(JSON.parse(await readFile(workerBeatPath(statePath), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeWorkerBeat(statePath: string, beat: WorkerBeat): Promise<void> {
  const path = workerBeatPath(statePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomHex(4)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(beat)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Only workers opt into recovery. Beat independently of batch/scan/publish completion: a healthy asynchronous
 * operation can exceed the recovery threshold. Stop and join this writer before deleting the beat or unlocking.
 */
export async function holdWorkerBeat(
  statePath: string,
  clock: QueueClock,
  delay: Delay = (ms, signal) => sleep(ms, undefined, { signal, ref: false }).catch(() => undefined)
): Promise<() => Promise<void>> {
  const monitor = await startWorkerWatchdog(statePath);
  try {
    await writeWorkerBeat(statePath, { v: 2, recovery: 'self-watchdog', pid: process.pid, at: clock.now() });
  } catch (error) {
    await monitor.stop();
    throw error;
  }
  const controller = new AbortController();
  const running = (async () => {
    for (;;) {
      await delay(WORKER_BEAT_MS, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      monitor.beat();
      await writeWorkerBeat(statePath, { v: 2, recovery: 'self-watchdog', pid: process.pid, at: clock.now() }).catch(
        () => undefined
      );
    }
  })().catch(() => undefined);
  return async () => {
    const stopped = monitor.stop();
    controller.abort();
    await Promise.all([running, stopped]);
  };
}
