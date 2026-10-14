import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { runCli } from '../src/cli/app.js';
import { acquireLock } from '../src/process-lock.js';
import { isDisabled, readWorkerVersion, writeTombstone } from '../src/queue/files.js';
import { listQueue } from '../src/queue/reader.js';
import { stopWorker } from '../src/queue/takeover.js';
import {
  createQueueHome,
  createWorkerPool,
  dshUsage,
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

let home: QueueHome;
let vt: VirtualTime;
let fake: FakeEffects;
let pool: WorkerPool;

beforeEach(async () => {
  home = await createQueueHome();
  vt = virtualTime();
  fake = fakeEffects();
  spawnMock.mockClear();
  pool = createWorkerPool({
    statePath: home.statePath,
    clock: vt.clock,
    monotonic: vt.monotonic,
    delay: vt.delay,
    isPidAlive: () => true,
    effects: fake.effects
  });
});

afterEach(async () => {
  await pool.stop();
  await home.dispose();
});

function stopOptions(starts: { count: number }) {
  return {
    clock: vt.clock,
    monotonic: vt.monotonic,
    delay: vt.delay,
    effects: fake.effects,
    startWorker: () => {
      starts.count += 1;
    }
  };
}

describe('worker --stop', () => {
  it('takes over from the running worker, applies the pending records, works off the owed items, and writes the tombstone', async () => {
    const publish = fake.holdPublishes();
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'));
    const running = pool.start();
    await publish.started;
    await recordAt(
      home.statePath,
      T0 + 1_000,
      eventBody('Heartbeat', 'd1', { source: 'dsh', usage: dshUsage, payloadKeys: ['usage'] })
    );
    const starts = { count: 0 };

    await stopWorker(home.statePath, stopOptions(starts));

    // The running worker stopped for the request and started one, which exited behind the command or at the tombstone.
    expect(await running).toBe('stop-request');
    const [, started] = await pool.settled();
    expect(['holder', 'tombstone']).toContain(started);
    expect(starts.count).toBe(0);
    expect(await isDisabled(home.statePath)).toBe(true);
    expect((await listQueue(home.statePath)).records).toEqual([]);
    const state = await readState(home.statePath);
    expect(Object.keys(state.sessions).sort()).toEqual(['d1', 's1']);
    expect(state.queueOwed).toEqual({ dshUsage: [], usageRefresh: [] });
    expect(fake.appended).toHaveLength(1);
    expect(fake.published).toHaveLength(1);
    expect(await readWorkerVersion(home.statePath)).toBe(0);
  });

  it('completes with the log lock held: its dsh append waits the bounded wait and stays owed', async () => {
    await recordAt(
      home.statePath,
      T0 + 1_000,
      eventBody('Heartbeat', 'd1', { source: 'dsh', usage: dshUsage, payloadKeys: ['usage'] })
    );
    const lock = await acquireLock(`${home.usageEventsPath}.lock.db`, new AbortController().signal, { retryMs: 10 });
    const starts = { count: 0 };
    try {
      await stopWorker(home.statePath, { ...stopOptions(starts), logLockWaitMs: 0 });

      expect(await isDisabled(home.statePath)).toBe(true);
      expect(starts.count).toBe(0);
      expect(fake.appended).toEqual([]);
      expect((await readState(home.statePath)).queueOwed?.dshUsage).toHaveLength(1);
      // The rest of the owed work was done: the rendered sync published through the fake effects.
      expect(fake.published).toHaveLength(1);
    } finally {
      await lock.release();
    }
  });

  it('applies nothing while the tombstone exists, and a worker started afterwards exits at once', async () => {
    await writeTombstone(home.statePath);
    await recordAt(home.statePath, T0, eventBody('SessionStart', 's1'));
    const starts = { count: 0 };

    await stopWorker(home.statePath, stopOptions(starts));

    expect(starts.count).toBe(0);
    expect((await listQueue(home.statePath)).records).toHaveLength(1);
    expect((await readState(home.statePath)).sessions).toEqual({});
    expect(await pool.start()).toBe('tombstone');
  });
});

describe('the worker command', () => {
  it('runs worker --stop and then exits at the tombstone it wrote', async () => {
    await runCli(['worker', '--stop']);
    expect(await isDisabled(home.statePath)).toBe(true);

    await runCli(['worker']);
    expect(await readWorkerVersion(home.statePath)).toBe(0);
    await until(async () => (await listQueue(home.statePath)).records.length === 0, 'an empty queue');
  });
});
