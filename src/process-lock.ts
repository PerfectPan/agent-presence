import { acquireProcessLock, type ProcessLock } from '@rivus/agent-kit-collab/process-lock';
import { kitPlatform } from './kit-platform.js';

// Acquisitions of one path inside this process take turns before they try the kit's lock. The kit's first attempt
// against a held lock blocks the thread while it settles (SQLite busy timeouts), so acquisitions contending inside one
// process would stall the event loop that the holder needs to finish and release.
const turns = new Map<string, Promise<void>>();

function waitForTurn(turn: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void turn.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/**
 * Take the kit's process lock on `path` (a SQLite database the kernel unlocks when the holder exits or crashes),
 * waiting for other processes and for earlier acquisitions in this one until `signal` aborts, which rejects with
 * `signal.reason`. `path` must be in an existing directory. Releasing the returned lock also ends this process's turn.
 */
export async function acquireLock(
  path: string,
  signal: AbortSignal,
  options: { retryMs?: number } = {}
): Promise<ProcessLock> {
  const previous = turns.get(path) ?? Promise.resolve();
  let endTurn: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    endTurn = resolve;
  });
  const queued = previous.then(() => ended);
  turns.set(path, queued);
  void queued.then(() => {
    if (turns.get(path) === queued) {
      turns.delete(path);
    }
  });

  try {
    await waitForTurn(previous, signal);
    const result = await acquireProcessLock(kitPlatform(), path, { wait: true, retryMs: options.retryMs, signal });
    // `wait: true` keeps trying until it holds the lock or the signal aborts, so a held result is not expected.
    if (!result.ok) {
      throw new Error(`process lock is held: ${path}`);
    }
    const lock = result.value;
    return {
      ...lock,
      release: async () => {
        try {
          await lock.release();
        } finally {
          endTurn();
        }
      }
    };
  } catch (error) {
    endTurn();
    throw error;
  }
}
