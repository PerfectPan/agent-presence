import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as z from 'zod/mini';
// Imported by name: called as `z.catch(...)`, the promise lint rule mistakes it for `Promise.prototype.catch`.
import { catch as catchInvalid } from 'zod/mini';
import { produceRecord } from '../src/queue/produce.js';
import { listQueue } from '../src/queue/reader.js';
import {
  createQueueHome,
  createWorkerPool,
  eventBody,
  fakeEffects,
  hookedPlatform,
  randomTurns,
  readState,
  virtualTime,
  type QueueHome,
  type VirtualTime,
  type WorkerPool
} from './queue-support.js';

// The idle-exit race for a worker: a producer renames its record at a random point while an idle worker
// leaves, and the leaving order still gets every record applied. The random delay is a number of event-loop
// turns. The command's half is in queue-command-race.test.ts, so the two run side by side.

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

// PRESENCE_RACE_RUNS sets how many race runs this file does (default 100); CONTRIBUTING.md says when to raise it.
const RUNS = catchInvalid(z.coerce.number().check(z.int(), z.minimum(1)), 100).parse(process.env.PRESENCE_RACE_RUNS);

let home: QueueHome;
let vt: VirtualTime;
let pool: WorkerPool;
/** Resolves when a worker next takes the lock. */
let lockTaken: Promise<void>;
let onLockTaken: () => void;

function expectLockTaken(): void {
  lockTaken = new Promise((resolve) => {
    onLockTaken = resolve;
  });
}

beforeEach(async () => {
  home = await createQueueHome();
  // No usage in the signature, so boundaries owe no refresh: the race is about records, not follow-up work.
  await home.writeConfig({ provider: 'feishu-signature' });
  vt = virtualTime();
  pool = createWorkerPool({
    statePath: home.statePath,
    clock: vt.clock,
    monotonic: vt.monotonic,
    delay: vt.delay,
    isPidAlive: () => true,
    effects: fakeEffects().effects,
    idleMs: 0,
    platform: hookedPlatform({ onTaken: () => onLockTaken() })
  });
});

afterEach(async () => {
  await pool.stop();
  await home.dispose();
});

describe('the idle exit under producers', () => {
  it(`leaves no record behind while producers record as idle workers leave, over ${RUNS} runs`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      // A worker on an empty queue takes the lock and leaves at its first quiet iteration; the producer records at a
      // random point from the moment it took the lock.
      expectLockTaken();
      void pool.start();
      await lockTaken;
      await randomTurns();
      const produced = await produceRecord(home.statePath, eventBody('SessionStart', `s${run}`), {
        clock: vt.clock
      });
      if (produced.status === 'recorded' && produced.startWorker) {
        void pool.start();
      }

      await pool.settled();
      expect((await listQueue(home.statePath)).records).toEqual([]);
    }
    expect(Object.keys((await readState(home.statePath)).sessions)).toHaveLength(RUNS);
  }, 300_000);
});
