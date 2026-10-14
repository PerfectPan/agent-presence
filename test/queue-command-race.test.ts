import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { produceRecord } from '../src/queue/produce.js';
import { listQueue } from '../src/queue/reader.js';
import { takeOver } from '../src/queue/takeover.js';
import {
  createQueueHome,
  createWorkerPool,
  eventBody,
  fakeEffects,
  randomTurns,
  readState,
  virtualTime,
  type QueueHome,
  type VirtualTime,
  type WorkerPool
} from './queue-support.js';

// Plan 0003 5.2's idle-exit race for a command: a producer renames its record at a random point while a command that
// took over holds the lock and leaves, and the leaving order (3.6) still gets every record applied. The random delay
// is a number of event-loop turns.

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

describe('the exit of a command under producers', () => {
  it(`leaves no record behind while producers record as commands that took over leave, over ${RUNS} runs`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      // A command like `status`: apply what is pending and the owed dsh usage, then leave.
      const command = takeOver(
        home.statePath,
        async (takeover) => {
          await takeover.applyPending();
          await takeover.workOffOwed(['dshUsage']);
        },
        { clock: vt.clock, monotonic: vt.monotonic, delay: vt.delay, startWorker: pool.starter() }
      );
      await randomTurns();
      const produced = await produceRecord(home.statePath, eventBody('SessionStart', `s${run}`), { clock: vt.clock });
      if (produced.status === 'recorded' && produced.startWorker) {
        void pool.start();
      }

      await command;
      await pool.settled();
      expect((await listQueue(home.statePath)).records).toEqual([]);
    }
    expect(Object.keys((await readState(home.statePath)).sessions)).toHaveLength(RUNS);
  }, 300_000);
});
