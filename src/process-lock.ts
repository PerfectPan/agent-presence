import { acquireProcessLock, type ProcessLock } from '@rivus/agent-kit-collab/process-lock';
import { kitPlatform } from './kit-platform.js';

/**
 * Take the kit's process lock on `path` (a SQLite database the kernel unlocks when the holder exits or crashes),
 * waiting for other processes and for other acquisitions of this process — the kit takes turns in memory — until
 * `signal` aborts, which rejects with `signal.reason`. `path` must be in an existing directory.
 */
export async function acquireLock(
  path: string,
  signal: AbortSignal,
  options: { retryMs?: number } = {}
): Promise<ProcessLock> {
  const result = await acquireProcessLock(kitPlatform(), path, { wait: true, retryMs: options.retryMs, signal });
  // `wait: true` keeps trying until it holds the lock or the signal aborts, so a held result is not expected.
  if (!result.ok) {
    throw new Error(`process lock is held: ${path}`);
  }
  return result.value;
}
