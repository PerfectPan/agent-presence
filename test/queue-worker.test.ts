import { mkdirSync, readdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ProcessLock, ProcessLockPlatform } from '@rivus/agent-kit-collab/process-lock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { kitPlatform } from '../src/kit-platform.js';
import {
  queuePaths,
  readWorkerVersion,
  recordFileName,
  writeTombstone,
  writeWorkerVersion
} from '../src/queue/files.js';
import { checkWorkerLock } from '../src/queue/produce.js';
import { listQueue } from '../src/queue/reader.js';
import { holdStopRequest, STOP_REQUEST_TOUCH_MS, type Delay } from '../src/queue/stop-request.js';
import { takeOver } from '../src/queue/takeover.js';
import {
  STARTED_WORKER_WAIT_MS,
  WORKER_IDLE_MS,
  type WorkerExitReason,
  type WorkerOptions
} from '../src/queue/worker.js';
import { tryWorkerLock } from '../src/queue/worker-lock.js';
import {
  createQueueHome,
  createWorkerPool,
  eventBody,
  fakeEffects,
  readState,
  recordAt,
  T0,
  until,
  virtualTime,
  type FakeEffects,
  type QueueHome,
  type VirtualTime,
  type WorkerPool
} from './queue-support.js';

// A sync inside the debounce interval schedules a deferred flush as a detached process; record it instead.
const spawnMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => { unref: () => void; on: () => void }>(() => ({
    unref: () => undefined,
    on: () => undefined
  }))
);
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock
}));

const COMMAND_PID = 4242;

let home: QueueHome;
let vt: VirtualTime;
let fake: FakeEffects;
let alive: Set<number>;
let heldLocks: ProcessLock[];
let pools: WorkerPool[];

beforeEach(async () => {
  home = await createQueueHome();
  vt = virtualTime();
  fake = fakeEffects();
  alive = new Set([process.pid, COMMAND_PID]);
  heldLocks = [];
  pools = [];
});

afterEach(async () => {
  for (const pool of pools) {
    await pool.stop();
  }
  for (const lock of heldLocks) {
    await lock.release();
  }
  await home.dispose();
});

function workers(defaults: Partial<WorkerOptions> = {}): WorkerPool {
  const pool = createWorkerPool({
    statePath: home.statePath,
    clock: vt.clock,
    monotonic: vt.monotonic,
    delay: vt.delay,
    isPidAlive: (pid) => alive.has(pid),
    effects: fake.effects,
    ...defaults
  });
  pools.push(pool);
  return pool;
}

/** Hold the worker lock in this test, as a process of another release would, with `version` written unless 0. */
async function holdLockAs(version: number): Promise<ProcessLock> {
  const lock = await tryWorkerLock(home.statePath, kitPlatform());
  if (!lock) {
    throw new Error('worker lock is held');
  }
  heldLocks.push(lock);
  if (version > 0) {
    await writeWorkerVersion(home.statePath, version);
  }
  return lock;
}

async function releaseLock(lock: ProcessLock): Promise<void> {
  heldLocks = heldLocks.filter((held) => held !== lock);
  await lock.release();
}

async function lockHeld(): Promise<boolean> {
  return (await checkWorkerLock(home.statePath)).held;
}

async function requestFiles(): Promise<string[]> {
  const prefix = basename(queuePaths(home.statePath).stopRequestPrefix);
  return (await readdir(home.dir)).filter((name) => name.startsWith(prefix));
}

function sessionIds(state: Awaited<ReturnType<typeof readState>>): string[] {
  return Object.keys(state.sessions).sort();
}

/** Write a stop request file by hand, synchronously, holding `pid` and dated `mtime`. */
function writeRequestSync(pid: number, mtime: number, token = 'manual'): string {
  const path = `${queuePaths(home.statePath).stopRequestPrefix}${token}`;
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSync(temporary, `${pid}\n`);
  renameSync(temporary, path);
  utimesSync(path, new Date(mtime), new Date(mtime));
  return path;
}

/** Write a record file by hand, synchronously, so a test can add one at an exact point of a worker's run. */
function writeRecordSync(at: number, sessionId: string, version = 1): void {
  const { queueDir } = queuePaths(home.statePath);
  mkdirSync(queueDir, { recursive: true, mode: 0o700 });
  const name = recordFileName(at, process.pid, 'sync');
  const record = {
    v: version,
    id: name.slice(0, -5),
    recordedAt: at,
    epoch: 0,
    ...eventBody('SessionStart', sessionId)
  };
  writeFileSync(join(queueDir, name), JSON.stringify(record));
}

/**
 * The kit's platform with hooks on the worker lock's SQLite connections: `onTaken` runs right after an acquisition
 * took the lock and `onReleased` right after a held lock is released, both synchronously, before the caller goes on.
 */
function hookedPlatform(hooks: { onTaken?: () => void; onReleased?: () => void }): ProcessLockPlatform {
  const base = kitPlatform();
  const { sqlite } = base;
  if (!sqlite) {
    throw new Error('the platform has no SQLite');
  }
  return {
    ...base,
    sqlite: {
      open(path, options) {
        const db = sqlite.open(path, options);
        if (options?.readonly === true || !path.endsWith('.worker.lock.db')) {
          return db;
        }
        let held = false;
        return {
          exec(sql) {
            db.exec(sql);
            if (sql === 'BEGIN EXCLUSIVE') {
              held = true;
              hooks.onTaken?.();
            }
          },
          prepare: (sql) => db.prepare(sql),
          close() {
            db.close();
            if (held) {
              held = false;
              hooks.onReleased?.();
            }
          }
        };
      }
    }
  };
}

/** The touch timer stays with the test; every other wait runs on virtual time. */
function touchesByHand(): { delay: Delay; tick: () => void } {
  let endWait: (() => void) | undefined;
  const delay: Delay = (ms, signal) => {
    if (ms !== STOP_REQUEST_TOUCH_MS) {
      return vt.delay(ms, signal);
    }
    return new Promise((resolve) => {
      endWait = resolve;
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
  return { delay, tick: () => endWait?.() };
}

describe('a started worker', () => {
  it('takes the free lock, writes its version, applies, and leaves after the idle interval with its version gone', async () => {
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'));
    const pool = workers();

    const run = pool.start();
    await until(async () => sessionIds(await readState(home.statePath)).includes('s1'), 'the record applied');
    expect(await readWorkerVersion(home.statePath)).toBe(1);
    await until(() => vt.monotonic.now() >= WORKER_IDLE_MS - 30_000, 'most of the idle interval');
    expect(await lockHeld()).toBe(true);

    expect(await run).toBe('idle');
    expect(vt.monotonic.now()).toBeGreaterThanOrEqual(WORKER_IDLE_MS);
    expect(await lockHeld()).toBe(false);
    expect(await readWorkerVersion(home.statePath)).toBe(0);
    expect(fake.published).toHaveLength(1);
    expect((await readState(home.statePath)).queueOwed?.renderedSync).toBeUndefined();
  }, 60_000);

  it('of twenty started together, one takes the lock and the others exit once it has written its version', async () => {
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'));
    const pool = workers({ idleMs: 1_000 });

    const reasons = await Promise.all(Array.from({ length: 20 }, () => pool.start()));

    expect(reasons.filter((reason) => reason === 'idle')).toHaveLength(1);
    expect(reasons.filter((reason) => reason === 'holder')).toHaveLength(19);
    expect(sessionIds(await readState(home.statePath))).toEqual(['s1']);
    expect((await readState(home.statePath)).queueApplied).toHaveLength(1);
  });

  it('waits behind an older holder and gives up at the 60-second limit without taking the lock', async () => {
    await holdLockAs(1);
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'), { version: 2 });
    const pool = workers();

    expect(await pool.start(2)).toBe('limit');

    expect(vt.monotonic.now()).toBeGreaterThanOrEqual(STARTED_WORKER_WAIT_MS);
    expect(await readWorkerVersion(home.statePath)).toBe(1);
    expect((await listQueue(home.statePath)).records).toHaveLength(1);

    // The worker the next hook starts applies the record once the older holder is gone.
    const [held] = heldLocks;
    if (held) {
      await releaseLock(held);
    }
    expect(await pool.start(2, { idleMs: 0 })).toBe('idle');
    expect(sessionIds(await readState(home.statePath))).toEqual(['s1']);
  });

  it('exits when the tombstone appears while it waits, without taking the lock', async () => {
    await holdLockAs(1);
    const pool = workers();

    const run = pool.start(2);
    await until(() => vt.monotonic.now() >= 5_000, 'a few rounds');
    await writeTombstone(home.statePath);

    expect(await run).toBe('tombstone');
    expect(await readWorkerVersion(home.statePath)).toBe(1);
  });

  it('waits while the holder has not written its version, and exits once it shows its own version or a newer one', async () => {
    const lock = await holdLockAs(0);
    const pool = workers();

    let settled = false;
    const run = pool.start(1).finally(() => {
      settled = true;
    });
    await until(() => vt.monotonic.now() >= 5_000, 'a few rounds');
    expect(settled).toBe(false);
    await writeWorkerVersion(home.statePath, 2);

    expect(await run).toBe('holder');
    await releaseLock(lock);
  });

  it('deletes a stop request older than the age bound, or dated past it, and takes the lock', async () => {
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'));
    // Dated far enough ahead that virtual time does not catch up with it during the test.
    writeRequestSync(process.pid, vt.clock.now() - 6_001, 'behind');
    writeRequestSync(process.pid, vt.clock.now() + 600_000, 'ahead');
    const pool = workers({ idleMs: 0 });

    expect(await pool.start()).toBe('idle');

    expect(await requestFiles()).toEqual([]);
    expect(sessionIds(await readState(home.statePath))).toEqual(['s1']);
  });
});

describe('a worker holding the lock', () => {
  it('leaves at the tombstone, deletes its version, and starts no worker with records pending', async () => {
    const pool = workers();
    const run = pool.start();
    await until(async () => (await readWorkerVersion(home.statePath)) === 1, 'the lock taken');

    await writeTombstone(home.statePath);
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'));

    expect(await run).toBe('tombstone');
    expect(pool.startedByLeavers()).toBe(0);
    expect(await readWorkerVersion(home.statePath)).toBe(0);
  });

  it('leaves for a live stop request, aborting the refresh in progress, which stays owed, and starts a worker', async () => {
    await recordAt(
      home.statePath,
      T0,
      eventBody('SessionStart', 'c1', { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' } })
    );
    const gate = fake.holdRefreshes();
    let startedByLeaver = 0;
    const pool = workers({
      startWorker: () => {
        startedByLeaver += 1;
      }
    });
    const run = pool.start();
    const refresh = await gate.started;

    const request = await holdStopRequest(home.statePath, { clock: vt.clock, pid: COMMAND_PID, delay: vt.delay });
    expect(await run).toBe('stop-request');
    await request.release();

    expect(refresh.signal.aborted).toBe(true);
    expect(startedByLeaver).toBe(1);
    expect(await readWorkerVersion(home.statePath)).toBe(0);
    const owed = (await readState(home.statePath)).queueOwed;
    expect(owed?.usageRefresh).toEqual([
      { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' }, boundaryAt: T0, generation: 1 }
    ]);
  });

  it('does not stop for a stop request dated past the age bound, and deletes it', async () => {
    const pool = workers();
    const run = pool.start();
    await until(async () => (await readWorkerVersion(home.statePath)) === 1, 'the lock taken');

    // Dated far enough ahead that virtual time does not catch up with it during the test.
    writeRequestSync(process.pid, vt.clock.now() + 600_000);
    await until(async () => (await requestFiles()).length === 0, 'the request deleted');
    await recordAt(home.statePath, vt.clock.now(), eventBody('SessionStart', 's1'));
    await until(async () => sessionIds(await readState(home.statePath)).includes('s1'), 'the record applied');

    await writeTombstone(home.statePath);
    expect(await run).toBe('tombstone');
  });

  it('that took the lock just before a request appeared stops at its first iteration without applying', async () => {
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'));
    let starts = 0;
    let armed = true;
    const pool = workers({
      platform: hookedPlatform({
        onTaken: () => {
          if (armed) {
            armed = false;
            writeRequestSync(COMMAND_PID, vt.clock.now());
          }
        }
      }),
      startWorker: () => {
        starts += 1;
      }
    });

    expect(await pool.start()).toBe('stop-request');

    expect(sessionIds(await readState(home.statePath))).toEqual([]);
    expect(starts).toBe(1);
  });
});

describe('a command taking over', () => {
  it('gets the lock before the started workers, which exit once it has written its version', async () => {
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'));
    // The holder's publish is still running when the command asks, so the sync stays owed and it starts a worker.
    const publish = fake.holdPublishes();
    const pool = workers();
    // An older worker holds the lock, so newer started workers wait for it.
    const older = pool.start(1);
    await publish.started;
    const waiting = [pool.start(2), pool.start(2)];
    await until(() => vt.monotonic.now() >= 5_000, 'the started workers waiting');

    let reasonsWhileHolding: WorkerExitReason[] = [];
    await takeOver(
      home.statePath,
      async (takeover) => {
        await takeover.applyPending();
        // The stopped worker started one of its own release; it and the waiting ones exit while the command holds.
        reasonsWhileHolding = await Promise.all([older, ...waiting, ...pool.runs.slice(3)]);
      },
      {
        version: 2,
        clock: vt.clock,
        monotonic: vt.monotonic,
        delay: vt.delay,
        effects: fake.effects,
        startWorker: () => undefined
      }
    );

    expect(reasonsWhileHolding).toEqual(['stop-request', 'holder', 'holder', 'holder']);
    await publish.aborted;
    expect(pool.startedByLeavers()).toBe(1);
    expect(sessionIds(await readState(home.statePath))).toEqual(['s1']);
    expect((await readState(home.statePath)).queueOwed?.renderedSync).toBe(true);
    expect(await requestFiles()).toEqual([]);
  });

  it('leaves the lock to the worker the holder started when the command dies while it waits', async () => {
    const pool = workers({ idleMs: 1_000 });
    const holder = pool.start();
    await until(async () => (await readWorkerVersion(home.statePath)) === 1, 'the worker holding');

    // A producer records while the holder holds the lock, and a command asks for it.
    writeRecordSync(vt.clock.now(), 's1');
    writeRequestSync(COMMAND_PID, vt.clock.now());
    expect(await holder).toBe('stop-request');
    expect(pool.startedByLeavers()).toBe(1);
    // The command is killed while it waits: its pid is gone, and its file stays until a reader finds it stale.
    alive.delete(COMMAND_PID);

    expect(await pool.settled()).toEqual(['stop-request', 'idle']);
    expect(sessionIds(await readState(home.statePath))).toEqual(['s1']);
    expect(await requestFiles()).toEqual([]);
  });

  it('writes its request again after the holder deleted it as stale when the clock jumped, and gets the lock', async () => {
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'));
    let pause: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      pause = resolve;
    });
    let resume: () => void = () => undefined;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let first = true;
    const pool = workers({
      onBatchStep: async (step) => {
        if (step === 'read' && first) {
          first = false;
          pause?.();
          await resumed;
        }
      }
    });
    const holder = pool.start();
    await paused;

    const touches = touchesByHand();
    let ranAt = -1;
    const command = takeOver(
      home.statePath,
      async () => {
        ranAt = vt.monotonic.now();
      },
      {
        clock: vt.clock,
        monotonic: vt.monotonic,
        delay: touches.delay,
        effects: fake.effects,
        startWorker: () => undefined
      }
    );
    await until(async () => (await requestFiles()).length === 1, 'the request written');
    const requestedAt = vt.monotonic.now();
    // The machine slept: the wall clock moved past the age bound while the command waited.
    vt.jump(30_000);
    resume();

    await until(async () => (await requestFiles()).length === 0, 'the holder deleting the stale request');
    expect(await lockHeld()).toBe(true);
    touches.tick();

    await command;
    expect(await holder).toBe('stop-request');
    expect(ranAt - requestedAt).toBeLessThan(10_000);
    expect(await requestFiles()).toEqual([]);
  });

  it('fails when the holder keeps the lock past its wait, leaving no request file', async () => {
    await holdLockAs(1);

    const command = takeOver(home.statePath, async () => 'ran', {
      clock: vt.clock,
      monotonic: vt.monotonic,
      delay: vt.delay,
      startWorker: () => undefined
    });

    await expect(command).rejects.toThrow('timed out waiting for the worker lock');
    expect(vt.monotonic.now()).toBeGreaterThanOrEqual(10_000);
    expect(await requestFiles()).toEqual([]);
  });
});

describe('an idle worker leaving', () => {
  it('makes no retake for a record it lists while a command waits, and exits once the command holds the lock', async () => {
    let command: Promise<void> | undefined;
    let idle: Promise<WorkerExitReason> | undefined;
    let idleReason: WorkerExitReason | undefined;
    const pool = workers({ idleMs: 1_000 });
    let armed = true;
    const platform = hookedPlatform({
      onReleased: () => {
        if (!armed) {
          return;
        }
        armed = false;
        // Right after the idle worker released the lock: a producer's record, and a command's request.
        writeRecordSync(vt.clock.now(), 's1');
        writeRequestSync(process.pid, vt.clock.now());
        command = takeOver(
          home.statePath,
          async (takeover) => {
            await takeover.applyPending();
            idleReason = await idle;
          },
          {
            clock: vt.clock,
            monotonic: vt.monotonic,
            delay: vt.delay,
            effects: fake.effects,
            startWorker: () => undefined
          }
        );
      }
    });

    idle = pool.start(1, { platform });
    await until(() => command !== undefined, 'the idle worker leaving');
    await command;

    expect(idleReason).toBe('holder');
    expect(sessionIds(await readState(home.statePath))).toEqual(['s1']);
  });

  it('keeps trying after losing its retake to an older holder, and applies its record once that holder left', async () => {
    const lockPath = queuePaths(home.statePath).workerLock;
    const raw = kitPlatform().sqlite;
    let olderHolder: { exec(sql: string): void; close(): void } | undefined;
    let armed = true;
    const platform = hookedPlatform({
      onReleased: () => {
        if (!armed || !raw) {
          return;
        }
        armed = false;
        // A newer producer records, and an older process takes the lock before the idle worker's retake.
        writeRecordSync(vt.clock.now(), 's2', 2);
        olderHolder = raw.open(lockPath);
        olderHolder.exec('PRAGMA locking_mode = EXCLUSIVE');
        olderHolder.exec('BEGIN EXCLUSIVE');
        writeFileSync(queuePaths(home.statePath).workerVersion, '1\n');
      }
    });
    const pool = workers({ idleMs: 1_000 });

    const run = pool.start(2, { platform });
    await until(() => olderHolder !== undefined, 'the idle worker leaving');
    await until(() => vt.monotonic.now() >= 10_000, 'the idle worker waiting as a started worker');
    expect(sessionIds(await readState(home.statePath))).toEqual([]);

    olderHolder?.exec('ROLLBACK');
    olderHolder?.close();

    expect(await run).toBe('idle');
    expect(sessionIds(await readState(home.statePath))).toEqual(['s2']);
  });
});

describe('the leaving order', () => {
  it('starts a worker when a command fails after taking over with records or owed work left', async () => {
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'));
    let starts = 0;
    const options = {
      clock: vt.clock,
      monotonic: vt.monotonic,
      delay: vt.delay,
      effects: fake.effects,
      startWorker: () => {
        starts += 1;
      }
    };

    await expect(
      takeOver(
        home.statePath,
        async () => {
          throw new Error('provider unavailable');
        },
        options
      )
    ).rejects.toThrow('provider unavailable');
    expect(starts).toBe(1);
    expect(await readWorkerVersion(home.statePath)).toBe(0);
    expect(await lockHeld()).toBe(false);

    // Applied, but the owed rendered sync is left.
    await expect(
      takeOver(
        home.statePath,
        async (takeover) => {
          await takeover.applyPending();
          throw new Error('provider unavailable');
        },
        options
      )
    ).rejects.toThrow('provider unavailable');
    expect(starts).toBe(2);

    await takeOver(home.statePath, (takeover) => takeover.workOffOwed(), options);
    expect(starts).toBe(2);
    expect(readdirSync(queuePaths(home.statePath).queueDir).filter((name) => name.endsWith('.json'))).toEqual([]);
  });
});
