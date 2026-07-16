import { appendFile, link, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_RETAIN_BYTES = 1024 * 1024;
export const LOG_LOCK_MARKER = 'agent-presence-log-retention-v1';
const LOG_LOCK_SUFFIX = '.agent-presence.lock';
const LOG_RECLAIM_SUFFIX = '.reclaim';
const LOG_LOCK_RETRY_MS = 10;
const LOG_LOCK_WAIT_ATTEMPTS = 250;
const LOG_LOCK_STALE_MS = 2_000;

export async function appendRetainedLogLine(path: string, line: string): Promise<void> {
  const lock = await acquireLogLock(path);
  if (lock === 'unavailable') {
    await appendFile(path, line, { mode: 0o600 });
    return;
  }
  if (lock === 'contended') {
    return;
  }

  try {
    await appendFile(path, line, { mode: 0o600 });
    await compactLogFile(path).catch(() => undefined);
  } finally {
    await lock.release();
  }
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

interface AcquiredLogLock {
  release(): Promise<void>;
}

async function acquireLogLock(path: string): Promise<AcquiredLogLock | 'contended' | 'unavailable'> {
  const lockPath = `${path}${LOG_LOCK_SUFFIX}`;
  const token = `${LOG_LOCK_MARKER}:${process.pid}:${randomUUID()}\n`;
  const candidatePath = `${lockPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(candidatePath, token, { flag: 'wx', mode: 0o600 });
  } catch {
    return 'unavailable';
  }

  try {
    for (let attempt = 0; attempt < LOG_LOCK_WAIT_ATTEMPTS; attempt += 1) {
      try {
        await link(candidatePath, lockPath);
        return {
          release: async () => {
            await removeOwnedLock(lockPath, token);
          }
        };
      } catch (error) {
        if (!hasNodeErrorCode(error, 'EEXIST')) {
          return 'unavailable';
        }

        const existingLock = await inspectExistingLock(lockPath);
        if (existingLock === 'foreign') {
          return 'unavailable';
        }
        if (existingLock.state === 'stale') {
          const reclaimResult = await reclaimStaleLock(lockPath, existingLock.token);
          if (reclaimResult === 'reclaimed') {
            continue;
          }
          await delay(LOG_LOCK_RETRY_MS);
          continue;
        }
        await delay(LOG_LOCK_RETRY_MS);
      }
    }
    return 'contended';
  } finally {
    await rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

interface OwnedLogLock {
  state: 'active' | 'stale';
  token: string;
}

async function inspectExistingLock(path: string): Promise<OwnedLogLock | 'foreign'> {
  try {
    const [contents, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const ownerPid = parseLockOwnerPid(contents);
    if (ownerPid === undefined) {
      return 'foreign';
    }
    return {
      state:
        Date.now() - metadata.mtimeMs > LOG_LOCK_STALE_MS && !isProcessAlive(ownerPid)
          ? 'stale'
          : 'active',
      token: contents
    };
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return {
        state: 'active',
        token: ''
      };
    }
    return 'foreign';
  }
}

async function reclaimStaleLock(path: string, expectedToken: string): Promise<'busy' | 'reclaimed' | 'retry'> {
  const reclaimPath = `${path}${LOG_RECLAIM_SUFFIX}`;
  try {
    await link(path, reclaimPath);
  } catch (error) {
    if (hasNodeErrorCode(error, 'EEXIST')) {
      return 'busy';
    }
    return hasNodeErrorCode(error, 'ENOENT') ? 'retry' : 'busy';
  }

  try {
    const [currentToken, reclaimToken, currentMetadata, reclaimMetadata] = await Promise.all([
      readFile(path, 'utf8'),
      readFile(reclaimPath, 'utf8'),
      stat(path),
      stat(reclaimPath)
    ]);
    const ownerPid = parseLockOwnerPid(currentToken);
    const stillStale =
      ownerPid !== undefined &&
      currentToken === expectedToken &&
      reclaimToken === expectedToken &&
      currentMetadata.ino === reclaimMetadata.ino &&
      Date.now() - currentMetadata.mtimeMs > LOG_LOCK_STALE_MS &&
      !isProcessAlive(ownerPid);
    if (!stillStale) {
      return 'retry';
    }

    await rm(path, { force: true });
    return 'reclaimed';
  } catch {
    return 'retry';
  } finally {
    await rm(reclaimPath, { force: true }).catch(() => undefined);
  }
}

function parseLockOwnerPid(token: string): number | undefined {
  const match = new RegExp(`^${LOG_LOCK_MARKER}:(\\d+):[0-9a-f-]+\\n$`).exec(token);
  if (!match) {
    return undefined;
  }
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasNodeErrorCode(error, 'EPERM');
  }
}

async function removeOwnedLock(path: string, token: string): Promise<void> {
  try {
    if (await readFile(path, 'utf8') === token) {
      await rm(path, { force: true });
    }
  } catch {
    // Lock cleanup is best-effort; a verified stale lock is reclaimed later.
  }
}

function hasNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
