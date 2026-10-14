import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { queuePaths } from '../src/queue/files.js';
import {
  deleteStopRequests,
  holdStopRequest,
  isPidAlive,
  liveStopRequests,
  STOP_REQUEST_FRESH_MS,
  STOP_REQUEST_TOUCH_MS,
  type Delay,
  type StopRequestHold
} from '../src/queue/stop-request.js';

const failingRequestReads = vi.hoisted(() => ({ enabled: false }));
const failingRequestRemovals = vi.hoisted(() => ({ enabled: false }));

// Reading, and removing, a request file fail with EACCES while the matching flag is enabled, as for a request another
// user left; narrowing the known union of each function's first parameter picks the request paths out.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const requestPath = (path: unknown): boolean =>
    typeof path === 'string' &&
    path.includes('.worker.stop.') &&
    (failingRequestReads.enabled || failingRequestRemovals.enabled);
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      if (failingRequestReads.enabled && requestPath(args[0])) {
        throw Object.assign(new Error('request read blocked by the test'), { code: 'EACCES' });
      }
      return original.readFile(...args);
    },
    rm: async (...args: Parameters<typeof original.rm>) => {
      if (failingRequestRemovals.enabled && requestPath(args[0])) {
        throw Object.assign(new Error('request removal blocked by the test'), { code: 'EACCES' });
      }
      return original.rm(...args);
    }
  };
});

const T = 1_760_000_000_000;
const COMMAND_PID = 4242;

let dir: string;
let statePath: string;
let hold: StopRequestHold | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-stop-request-'));
  statePath = join(dir, 'state.json');
});

afterEach(async () => {
  failingRequestReads.enabled = false;
  failingRequestRemovals.enabled = false;
  await hold?.release();
  hold = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** The machine's wall clock, which tests move; the command and every reader share it. */
function movableClock(start: number): { now: () => number; set: (now: number) => void } {
  let current = start;
  return {
    now: () => current,
    set: (now) => {
      current = now;
    }
  };
}

const alive = (pid: number): boolean => pid === COMMAND_PID;

/**
 * Stands in for the touch timer: `tick()` ends the current wait and resolves once the hold has touched its request and
 * started the next wait.
 */
function manualDelay(): { delay: Delay; tick: () => Promise<void> } {
  let endWait: (() => void) | undefined;
  let waiting: (() => void) | undefined;
  const delay: Delay = (ms, signal) =>
    new Promise((resolve) => {
      expect(ms).toBe(STOP_REQUEST_TOUCH_MS);
      endWait = resolve;
      if (signal.aborted) {
        resolve();
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
      waiting?.();
    });
  return {
    delay,
    tick: async () => {
      const next = new Promise<void>((resolveNext) => {
        waiting = resolveNext;
      });
      endWait?.();
      await next;
    }
  };
}

async function mtimeOf(path: string): Promise<number> {
  return (await stat(path)).mtimeMs;
}

async function requestFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith('state.json.worker.stop.'));
}

describe('holdStopRequest', () => {
  it('writes its pid to a request file dated by the clock', async () => {
    const clock = movableClock(T);
    hold = await holdStopRequest(statePath, { clock, pid: COMMAND_PID, delay: manualDelay().delay });

    expect(hold.request.path.startsWith(queuePaths(statePath).stopRequestPrefix)).toBe(true);
    expect(await readFile(hold.request.path, 'utf8')).toBe(`${COMMAND_PID}\n`);
    expect(await mtimeOf(hold.request.path)).toBe(T);
    expect((await stat(hold.request.path)).mode & 0o777).toBe(0o600);
    expect(await requestFiles()).toHaveLength(1);
  });

  it('touches the request every touch period, which keeps it live past the age bound', async () => {
    const clock = movableClock(T);
    const timer = manualDelay();
    hold = await holdStopRequest(statePath, { clock, pid: COMMAND_PID, delay: timer.delay });

    clock.set(T + STOP_REQUEST_TOUCH_MS);
    await timer.tick();
    clock.set(T + 2 * STOP_REQUEST_TOUCH_MS);
    await timer.tick();

    expect(await mtimeOf(hold.request.path)).toBe(T + 2 * STOP_REQUEST_TOUCH_MS);
    clock.set(T + 2 * STOP_REQUEST_TOUCH_MS + STOP_REQUEST_FRESH_MS);
    expect(await liveStopRequests(statePath, { clock, isPidAlive: alive })).toEqual([hold.request]);
  });

  it('writes the request again with the same name and pid after a reader deleted it as stale', async () => {
    const clock = movableClock(T);
    const timer = manualDelay();
    hold = await holdStopRequest(statePath, { clock, pid: COMMAND_PID, delay: timer.delay });

    // The clock moves forward past the bound during the wait, as after a sleep.
    clock.set(T + STOP_REQUEST_FRESH_MS + 30_000);
    expect(await liveStopRequests(statePath, { clock, isPidAlive: alive })).toEqual([]);
    expect(await requestFiles()).toEqual([]);

    await timer.tick();

    expect(await readFile(hold.request.path, 'utf8')).toBe(`${COMMAND_PID}\n`);
    expect(await liveStopRequests(statePath, { clock, isPidAlive: alive })).toEqual([hold.request]);
  });

  it('stops touching and deletes the request on release', async () => {
    const clock = movableClock(T);
    const timer = manualDelay();
    hold = await holdStopRequest(statePath, { clock, pid: COMMAND_PID, delay: timer.delay });

    await hold.release();
    await hold.release();

    expect(await requestFiles()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('liveStopRequests', () => {
  async function requestAt(mtime: number, pid = COMMAND_PID): Promise<void> {
    const clock = movableClock(mtime);
    hold = await holdStopRequest(statePath, { clock, pid, delay: manualDelay().delay });
  }

  it.each([
    ['at the reader clock', 0],
    ['the age bound behind the reader clock', -STOP_REQUEST_FRESH_MS],
    ['the age bound ahead of the reader clock', STOP_REQUEST_FRESH_MS]
  ])('counts a request of a live pid dated %s', async (_name, offset) => {
    await requestAt(T + offset);

    expect(await liveStopRequests(statePath, { clock: { now: () => T }, isPidAlive: alive })).toEqual([hold?.request]);
    expect(await requestFiles()).toHaveLength(1);
  });

  it.each([
    ['older than the age bound', -STOP_REQUEST_FRESH_MS - 1],
    ['further ahead than the age bound, after the clock was set back', STOP_REQUEST_FRESH_MS + 1]
  ])('deletes a request of a live pid dated %s', async (_name, offset) => {
    await requestAt(T + offset);

    expect(await liveStopRequests(statePath, { clock: { now: () => T }, isPidAlive: alive })).toEqual([]);
    expect(await requestFiles()).toEqual([]);
  });

  it('deletes a fresh request whose pid is gone', async () => {
    await requestAt(T, 7);

    expect(await liveStopRequests(statePath, { clock: { now: () => T }, isPidAlive: alive })).toEqual([]);
    expect(await requestFiles()).toEqual([]);
  });

  it.each(['', 'pid', '0', '-5', '12abc'])('deletes a fresh request holding %j', async (text) => {
    const path = `${queuePaths(statePath).stopRequestPrefix}manual`;
    await writeFile(path, text);
    await utimes(path, new Date(T), new Date(T));

    expect(await liveStopRequests(statePath, { clock: { now: () => T }, isPidAlive: () => true })).toEqual([]);
    expect(await requestFiles()).toEqual([]);
  });

  it('ignores other files and finds nothing when the state directory does not exist', async () => {
    await writeFile(join(dir, 'state.json'), '{}');
    await writeFile(join(dir, 'other.json.worker.stop.x'), `${COMMAND_PID}\n`);
    await mkdir(`${queuePaths(statePath).stopRequestPrefix}dir`);

    expect(await liveStopRequests(statePath, { clock: { now: () => T }, isPidAlive: alive })).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual([
      'other.json.worker.stop.x',
      'state.json',
      'state.json.worker.stop.dir'
    ]);
    expect(
      await liveStopRequests(join(dir, 'missing', 'state.json'), { clock: { now: () => T }, isPidAlive: alive })
    ).toEqual([]);
  });

  it('treats an unreadable request as stale and removes it', async () => {
    const path = `${queuePaths(statePath).stopRequestPrefix}manual`;
    await writeFile(path, `${COMMAND_PID}\n`);
    await utimes(path, new Date(T), new Date(T));
    failingRequestReads.enabled = true;

    await expect(liveStopRequests(statePath, { clock: { now: () => T }, isPidAlive: alive })).resolves.toEqual([]);
    expect(await requestFiles()).toEqual([]);
  });

  it('ignores an unreadable request it cannot remove, and logs it once', async () => {
    const path = `${queuePaths(statePath).stopRequestPrefix}manual`;
    await writeFile(path, `${COMMAND_PID}\n`);
    await utimes(path, new Date(T), new Date(T));
    const logPath = join(dir, 'requests.log');
    process.env.AGENT_PRESENCE_LOG_FILE = logPath;
    failingRequestReads.enabled = true;
    failingRequestRemovals.enabled = true;
    try {
      await expect(liveStopRequests(statePath, { clock: { now: () => T }, isPidAlive: alive })).resolves.toEqual([]);
    } finally {
      failingRequestReads.enabled = false;
      failingRequestRemovals.enabled = false;
      delete process.env.AGENT_PRESENCE_LOG_FILE;
    }

    expect(await requestFiles()).toEqual(['state.json.worker.stop.manual']);
    expect((await readFile(logPath, 'utf8')).match(/worker.stop-request.stale/g)).toHaveLength(1);
  });
});

describe('deleteStopRequests', () => {
  it('deletes every request of the state file, live or not', async () => {
    hold = await holdStopRequest(statePath, { clock: { now: () => T }, pid: COMMAND_PID, delay: manualDelay().delay });
    await writeFile(`${queuePaths(statePath).stopRequestPrefix}stale`, '1\n');

    await deleteStopRequests(statePath);

    expect(await requestFiles()).toEqual([]);
  });
});

describe('isPidAlive', () => {
  it('tells a running process from one that exited', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    const { pid } = child;
    await once(child, 'exit');

    expect(isPidAlive(process.pid)).toBe(true);
    expect(pid === undefined ? undefined : isPidAlive(pid)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});
