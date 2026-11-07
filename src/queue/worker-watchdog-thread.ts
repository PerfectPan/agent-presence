import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { workerData } from 'node:worker_threads';

// This module imports only Node built-ins, so the monitor remains independent of the worker's queue/state locks.
// workerData is constructed internally, never read from a queue record or a user-controlled file.
const {
  control: buffer,
  stopRequestPrefix,
  staleMs,
  pollMs,
  requestFreshMs
} = workerData as {
  control: SharedArrayBuffer;
  stopRequestPrefix: string;
  staleMs: number;
  pollMs: number;
  requestFreshMs: number;
};
const control = new BigInt64Array(buffer);
const staleNs = BigInt(staleMs) * 1_000_000n;

function commandIsWaiting(): boolean {
  try {
    for (const name of readdirSync(dirname(stopRequestPrefix))) {
      if (!name.startsWith(basename(stopRequestPrefix))) {
        continue;
      }
      try {
        const path = join(dirname(stopRequestPrefix), name);
        const pid = Number(readFileSync(path, 'utf8').trim());
        if (
          !Number.isSafeInteger(pid) ||
          pid <= 0 ||
          pid === process.pid ||
          Math.abs(Date.now() - statSync(path).mtimeMs) > requestFreshMs
        ) {
          continue;
        }
        process.kill(pid, 0);
        return true;
      } catch {
        // An unreadable, expired, removed or dead request cannot authorize self-termination.
      }
    }
  } catch {
    // Failure to inspect requests leaves the worker alone.
  }
  return false;
}

setInterval(() => {
  if (
    Atomics.load(control, 0) !== 1n ||
    process.hrtime.bigint() - Atomics.load(control, 1) < staleNs ||
    !commandIsWaiting()
  ) {
    return;
  }
  if (Atomics.compareExchange(control, 0, 1n, -1n) === 1n) {
    // All threads have this pid. It cannot be reused while this thread is executing the syscall.
    process.kill(process.pid, 'SIGKILL');
  }
}, pollMs);
