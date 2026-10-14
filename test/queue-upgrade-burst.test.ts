import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ProcessLock } from '@rivus/agent-kit-collab/process-lock';
import { kitPlatform } from '../src/kit-platform.js';
import { readWorkerVersion, writeWorkerVersion } from '../src/queue/files.js';
import { produceRecord } from '../src/queue/produce.js';
import { listQueue } from '../src/queue/reader.js';
import { takeOver } from '../src/queue/takeover.js';
import type { WorkerExitReason } from '../src/queue/worker.js';
import { tryWorkerLock } from '../src/queue/worker-lock.js';
import type { StartWorker } from '../src/queue/start-worker.js';
import {
  createQueueHome,
  createWorkerPool,
  eventBody,
  fakeEffects,
  readState,
  until,
  T0,
  virtualTime,
  writeState,
  type FakeEffects,
  type QueueHome,
  type VirtualTime,
  type WorkerPool
} from './queue-support.js';

// Plan 0003 5.3's producer checks at the lock: the upgrade burst, and producers recording while a command holds the
// worker lock. The producers are `produceRecord`, whose version parameter stands for the release (6.3), so one build
// runs an older release (1) and a newer one (2).

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

const OLDER = 1;
const NEWER = 2;

let home: QueueHome;
let vt: VirtualTime;
let fake: FakeEffects;
let pool: WorkerPool;

beforeEach(async () => {
  home = await createQueueHome();
  // No usage in the signature, so boundaries owe no refresh: these checks are about records at the lock.
  await home.writeConfig({ provider: 'feishu-signature' });
  vt = virtualTime();
  fake = fakeEffects();
  pool = createWorkerPool({
    statePath: home.statePath,
    clock: vt.clock,
    monotonic: vt.monotonic,
    delay: vt.delay,
    isPidAlive: () => true,
    effects: fake.effects,
    idleMs: 1_000
  });
});

afterEach(async () => {
  await pool.stop();
  await home.dispose();
});

describe('the upgrade burst', () => {
  it('of 100 newer producers while an older worker runs leaves one newer worker applying every event once', async () => {
    // 200 running sessions with distinct heartbeats, all older than the burst events and inside the ttl, so none of
    // them expires: each burst `Stop` fallback-finishes the running session with the latest heartbeat, so one
    // application finishes 100 of them and a batch applied twice finishes 200. The session a second pass revives
    // keeps its old heartbeat, so the fallback would pick it again — finishes, not starts, are what a doubling shows.
    const seeded = Array.from({ length: 200 }, (_, index) => [
      `p${index}`,
      {
        id: `p${index}`,
        source: 'codex',
        kind: 'coding' as const,
        status: 'running' as const,
        startedAt: T0 - 100_000 + index,
        lastHeartbeatAt: T0 - 100_000 + index
      }
    ]);
    await writeState(home.statePath, { sessions: Object.fromEntries(seeded) });
    // A long idle interval keeps the older worker at the lock until the burst's first record arrives.
    const older = pool.start(OLDER, { idleMs: 300_000 });
    await until(async () => (await readWorkerVersion(home.statePath)) === OLDER, 'the older worker holding the lock');

    const produced = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        produceRecord(home.statePath, eventBody('Stop', `gone${index}`), {
          version: NEWER,
          clock: vt.clock
        })
      )
    );
    expect(produced.every((outcome) => outcome.status === 'recorded')).toBe(true);

    const newerRuns: Array<Promise<WorkerExitReason>> = [];
    for (const outcome of produced) {
      if (outcome.status === 'recorded' && outcome.startWorker) {
        newerRuns.push(pool.start(NEWER));
      }
    }
    expect(newerRuns.length).toBeGreaterThanOrEqual(1);

    // The older worker stops at the first newer record and starts no worker; one newer worker applies the burst.
    expect(await older).toBe('newer-record');
    expect(pool.startedByLeavers()).toBe(0);
    const reasons = await Promise.all(newerRuns);
    expect(reasons.filter((reason) => reason === 'idle')).toHaveLength(1);
    expect(reasons.filter((reason) => reason === 'holder')).toHaveLength(reasons.length - 1);

    const sessions = Object.values((await readState(home.statePath)).sessions);
    expect(sessions).toHaveLength(200);
    expect(sessions.filter((session) => session.status === 'finished')).toHaveLength(100);
    expect(sessions.filter((session) => session.status === 'running')).toHaveLength(100);
    expect((await listQueue(home.statePath)).records).toEqual([]);
  }, 120_000);
});

describe('producers while a command holds the lock', () => {
  it('a newer producer while a command of the older release holds the lock for 20 seconds starts a worker that waits and applies the record after the command leaves', async () => {
    const starts = { count: 0 };
    const started: StartWorker = () => {
      starts.count += 1;
    };
    // The command keeps the lock until 20 seconds of virtual time have passed; the waiting worker's rounds move it.
    const command = takeOver(
      home.statePath,
      async (takeover) => {
        await until(() => vt.monotonic.now() >= 20_000, 'the command holding the lock for 20 seconds');
        await takeover.applyPending();
      },
      {
        version: OLDER,
        clock: vt.clock,
        monotonic: vt.monotonic,
        delay: vt.delay,
        effects: fake.effects,
        startWorker: started
      }
    );
    await until(async () => (await readWorkerVersion(home.statePath)) === OLDER, 'the command holding the lock');

    const produced = await produceRecord(home.statePath, eventBody('SessionStart', 's1'), {
      version: NEWER,
      clock: vt.clock
    });
    expect(produced).toMatchObject({ status: 'recorded', startWorker: true });
    const waiting = pool.start(NEWER);

    await command;
    expect(starts.count).toBe(1);
    expect(await waiting).toBe('idle');
    expect((await readState(home.statePath)).sessions.s1).toMatchObject({ status: 'running' });
    expect((await listQueue(home.statePath)).records).toEqual([]);
  }, 60_000);

  it('a producer while a command of its own release holds the lock starts no worker, and the worker the command starts applies the record', async () => {
    const command = takeOver(
      home.statePath,
      async () => {
        // Recorded and checked while the command holds the lock and has written its version.
        const produced = await produceRecord(home.statePath, eventBody('SessionStart', 's1'), { clock: vt.clock });
        expect(produced).toMatchObject({ status: 'recorded', startWorker: false });
      },
      {
        clock: vt.clock,
        monotonic: vt.monotonic,
        delay: vt.delay,
        effects: fake.effects,
        startWorker: pool.starter()
      }
    );

    await command;
    await pool.settled();

    expect((await readState(home.statePath)).sessions.s1).toMatchObject({ status: 'running' });
    expect((await listQueue(home.statePath)).records).toEqual([]);
  }, 60_000);

  it('a producer that checks after a holder took the lock and before it wrote its version starts a worker, which exits once the version is written', async () => {
    // A holder in its first milliseconds: the lock is taken, `<state>.worker.v` is not written yet.
    const held: ProcessLock | undefined = await tryWorkerLock(home.statePath, kitPlatform());
    if (!held) {
      throw new Error('worker lock is held');
    }

    const produced = await produceRecord(home.statePath, eventBody('SessionStart', 's1'), { clock: vt.clock });
    expect(produced).toMatchObject({ status: 'recorded', startWorker: true });
    const started = pool.start();

    await writeWorkerVersion(home.statePath, OLDER);
    expect(await started).toBe('holder');
    expect((await listQueue(home.statePath)).records).toHaveLength(1);

    await held.release();
  }, 60_000);
});
