import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { readWorkerVersion } from '../src/queue/files.js';
import { produceRecord } from '../src/queue/produce.js';
import { listQueue } from '../src/queue/reader.js';
import {
  createQueueHome,
  createWorkerPool,
  eventBody,
  fakeEffects,
  randomTurns,
  readState,
  until,
  virtualTime,
  type QueueHome,
  type VirtualTime,
  type WorkerPool
} from './queue-support.js';

// Plan 0003 5.2's idle-exit race for a worker: a producer renames its record at a random point while an idle worker
// leaves, and the leaving order (3.6) still gets every record applied. The random delay is a number of event-loop
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

const RUNS = 1_000;

let home: QueueHome;
let vt: VirtualTime;
let pool: WorkerPool;

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
    idleMs: 0
  });
});

afterEach(async () => {
  await pool.stop();
  await home.dispose();
});

describe('the idle exit under producers', () => {
  it(`leaves no record behind while producers record as idle workers leave, over ${RUNS} runs`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      // A worker on an empty queue takes the lock and leaves at its first quiet iteration.
      void pool.start();
      await until(async () => (await readWorkerVersion(home.statePath)) === 1, 'the worker holding');
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
