import { appendFile, open } from 'node:fs/promises';
import type { ProcessLock } from '@rivus/agent-kit-collab/process-lock';
import { acquireLock } from './process-lock.js';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_RETAIN_BYTES = 1024 * 1024;
const LOG_LOCK_RETRY_MS = 10;
/** How long an append waits for the log lock by default before it skips the line. */
const LOG_LOCK_WAIT_MS = 2_500;

function hasNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function compactLogFile(path: string): Promise<void> {
  let file;
  try {
    file = await open(path, 'r+');
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }

  try {
    const metadata = await file.stat();
    if (metadata.size <= LOG_MAX_BYTES) {
      return;
    }

    const retainedSize = Math.min(metadata.size, LOG_RETAIN_BYTES);
    const retained = Buffer.allocUnsafe(retainedSize);
    const { bytesRead } = await file.read(retained, 0, retainedSize, metadata.size - retainedSize);
    const retainedTail = retained.subarray(0, bytesRead);

    await file.truncate(0);
    await file.writeFile(retainedTail);
  } finally {
    await file.close();
  }
}

async function acquireLogLock(path: string, signal: AbortSignal): Promise<ProcessLock | 'contended' | 'unavailable'> {
  try {
    // Releases that append to the same file exclude each other only while they lock this same path.
    return await acquireLock(`${path}.lock.db`, signal, { retryMs: LOG_LOCK_RETRY_MS });
  } catch {
    return signal.aborted ? 'contended' : 'unavailable';
  }
}

/**
 * Append `line` to the log at `path` under its log lock, then compact the file in place once it passes
 * `LOG_MAX_BYTES`. The append waits for the lock until `signal` aborts (by default after `LOG_LOCK_WAIT_MS`) and then
 * skips the line rather than race a compaction. If the lock cannot be taken at all, for example because the directory
 * is not writable, the line is appended without the lock and without compaction. Resolves whether the line was
 * written.
 */
export async function appendRetainedLogLine(
  path: string,
  line: string,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  const lock = await acquireLogLock(path, options.signal ?? AbortSignal.timeout(LOG_LOCK_WAIT_MS));
  if (lock === 'unavailable') {
    await appendFile(path, line, { mode: 0o600 });
    return true;
  }
  if (lock === 'contended') {
    return false;
  }

  try {
    await appendFile(path, line, { mode: 0o600 });
    await compactLogFile(path).catch(() => undefined);
    return true;
  } finally {
    await lock.release();
  }
}
