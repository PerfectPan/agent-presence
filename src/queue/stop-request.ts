import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage } from '../cli/errors.js';
import { hasNodeErrorCode } from '../json-file.js';
import { writeLogEvent } from '../log.js';
import { queuePaths, randomHex, systemClock, type QueueClock } from './files.js';

// A command asks for the worker lock with a stop request: the file `<state>.worker.stop.<token>`
// holding its pid as decimal text. Every release with the queue keeps that name, the format, the touch period and the
// age bound below.

/** How often a waiting command touches its request, and writes it again if it is gone. */
export const STOP_REQUEST_TOUCH_MS = 2_000;
/** A request counts while its modification time is within this of the reader's clock, before or after it. */
export const STOP_REQUEST_FRESH_MS = 6_000;

export interface StopRequest {
  readonly path: string;
  readonly pid: number;
}

export type PidAlive = (pid: number) => boolean;
/** Resolves after `ms`; once `signal` is aborted, already or later, it settles at once, either way. */
export type Delay = (ms: number, signal: AbortSignal) => Promise<void>;

/** Whether a process with this pid exists. */
export function isPidAlive(pid: number): boolean {
  // `kill` with 0 or a negative pid signals a process group, which would read as alive.
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return hasNodeErrorCode(error, 'EPERM');
  }
}

// The timer does not keep the process alive: the command's wait for the lock does.
const unrefDelay: Delay = (ms, signal) => sleep(ms, undefined, { signal, ref: false });

const PID = /^[1-9]\d*$/;

function parsePid(text: string): number | undefined {
  const trimmed = text.trim();
  const pid = Number(trimmed);
  return PID.test(trimmed) && Number.isSafeInteger(pid) ? pid : undefined;
}

/**
 * Written to a temporary file and renamed, so a reader never finds a request without its pid; the temporary name
 * starts with a dot, so it never carries the request prefix. The modification time is set from `clock`.
 */
async function writeRequestFile(request: StopRequest, clock: QueueClock): Promise<void> {
  const temporary = join(dirname(request.path), `.${basename(request.path)}.${randomHex(4)}.tmp`);
  try {
    await writeFile(temporary, `${request.pid}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, request.path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const now = new Date(clock.now());
  await utimes(request.path, now, now);
}

/** Set the request's modification time to now, or write it again with the same name and pid if it is gone. */
async function touchRequest(request: StopRequest, clock: QueueClock): Promise<void> {
  const now = new Date(clock.now());
  try {
    await utimes(request.path, now, now);
  } catch (error) {
    if (!hasNodeErrorCode(error, 'ENOENT')) {
      throw error;
    }
    await writeRequestFile(request, clock);
  }
}

async function requestFiles(statePath: string): Promise<string[]> {
  const { stopRequestPrefix } = queuePaths(statePath);
  const dir = dirname(stopRequestPrefix);
  const prefix = basename(stopRequestPrefix);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => join(dir, entry.name));
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
}

/** The request's pid and modification time; `undefined` pid when the text is not a pid, `missing` when it is gone. */
async function readRequest(
  path: string
): Promise<{ pid: number | undefined; mtimeMs: number } | 'missing' | { readonly unreadable: unknown }> {
  try {
    const info = await stat(path);
    return { pid: parsePid(await readFile(path, 'utf8')), mtimeMs: info.mtimeMs };
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return 'missing';
    }
    return { unreadable: error };
  }
}

async function logQuietly(event: Record<string, unknown>): Promise<void> {
  try {
    await writeLogEvent(event);
  } catch {
    // Diagnostic only.
  }
}

// The unremovable request paths this process has logged: a holder checks every 250 ms, so the same file would
// log on every check. The path leaves the set once its file is gone, so a later file there logs again.
const staleRequestsLogged = new Set<string>();

/** Remove a stale request; when that fails too, keep the reader going and log the request once per file. */
async function removeStaleRequest(path: string, readError: unknown): Promise<void> {
  try {
    await rm(path, { force: true });
    staleRequestsLogged.delete(path);
  } catch (error) {
    if (staleRequestsLogged.has(path)) {
      return;
    }
    staleRequestsLogged.add(path);
    await logQuietly({
      type: 'worker.stop-request.stale',
      file: basename(path),
      error: errorMessage(error),
      read: errorMessage(readError)
    });
  }
}

export interface StopRequestCheck {
  /** The reader's wall clock; the system's by default. */
  readonly clock?: QueueClock;
  /** `isPidAlive` by default. */
  readonly isPidAlive?: PidAlive;
}

/**
 * The live stop requests for the worker lock of `statePath`: those whose pid is alive and whose modification time is
 * within `STOP_REQUEST_FRESH_MS` of `clock`, before or after it. Every other request file found, one without a valid
 * pid or an unreadable one included, is stale and deleted.
 */
export async function liveStopRequests(statePath: string, check: StopRequestCheck = {}): Promise<StopRequest[]> {
  const clock = check.clock ?? systemClock;
  const alive = check.isPidAlive ?? isPidAlive;
  const live: StopRequest[] = [];
  for (const path of await requestFiles(statePath)) {
    const found = await readRequest(path);
    if (found === 'missing') {
      continue;
    }
    if ('unreadable' in found) {
      // A request another user left can be unreadable (EACCES): treat it as stale instead of failing every reader.
      await removeStaleRequest(path, found.unreadable);
      continue;
    }
    const { pid, mtimeMs } = found;
    if (pid !== undefined && Math.abs(clock.now() - mtimeMs) <= STOP_REQUEST_FRESH_MS && alive(pid)) {
      live.push({ path, pid });
    } else {
      await rm(path, { force: true });
    }
  }
  return live;
}

/** Delete every stop request file of `statePath`, live or not, as `uninstall --all` does. */
export async function deleteStopRequests(statePath: string): Promise<void> {
  for (const path of await requestFiles(statePath)) {
    await rm(path, { force: true });
  }
}

export interface StopRequestHold {
  readonly request: StopRequest;
  /** Stop touching the request, wait for a touch in progress, then delete the file. Later calls return the same. */
  release(): Promise<void>;
}

export interface HoldStopRequestOptions {
  /** Sets the request's modification time at every write and touch; the system's clock by default. */
  readonly clock?: QueueClock;
  /** The pid the request holds; this process's by default. */
  readonly pid?: number;
  /** Waits between touches; an unreferenced timer by default. */
  readonly delay?: Delay;
}

/**
 * Write a stop request for the worker lock of `statePath` and keep it live while the caller waits: touch it every
 * `STOP_REQUEST_TOUCH_MS`, and write it again with the same name and pid if a reader deleted it as stale, for example
 * after the clock moved during a sleep. The caller stays alive for its whole wait and releases the hold
 * once it gets the lock or gives up.
 */
export async function holdStopRequest(
  statePath: string,
  options: HoldStopRequestOptions = {}
): Promise<StopRequestHold> {
  const clock = options.clock ?? systemClock;
  const request: StopRequest = {
    path: `${queuePaths(statePath).stopRequestPrefix}${randomHex(4)}`,
    pid: options.pid ?? process.pid
  };
  await mkdir(dirname(request.path), { recursive: true, mode: 0o700 });
  await writeRequestFile(request, clock);

  const controller = new AbortController();
  const delay = options.delay ?? unrefDelay;
  const touching = (async () => {
    for (;;) {
      try {
        await delay(STOP_REQUEST_TOUCH_MS, controller.signal);
      } catch {
        return;
      }
      if (controller.signal.aborted) {
        return;
      }
      // A failed touch is tried again at the next one.
      await touchRequest(request, clock).catch(() => undefined);
    }
  })();

  let released: Promise<void> | undefined;
  return {
    request,
    release() {
      released ??= (async () => {
        controller.abort();
        await touching;
        await rm(request.path, { force: true });
      })();
      return released;
    }
  };
}
