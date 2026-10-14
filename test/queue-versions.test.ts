import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { loadConfig } from '../src/config.js';
import { applyQueueBatch } from '../src/queue/apply.js';
import { queuePaths, readWorkerVersion } from '../src/queue/files.js';
import { produceRecord, type RecordBody } from '../src/queue/produce.js';
import { listQueue } from '../src/queue/reader.js';
import type { Delay } from '../src/queue/stop-request.js';
import { takeOver } from '../src/queue/takeover.js';
import type { WorkerOptions } from '../src/queue/worker.js';
import {
  createQueueHome,
  createWorkerPool,
  eventBody,
  fakeEffects,
  readRawState,
  readState,
  recordAt,
  T0,
  until,
  virtualTime,
  writeState,
  type FakeEffects,
  type QueueHome,
  type VirtualTime,
  type WorkerPool
} from './queue-support.js';

// Plan 0003 5.3's checks that need no producer command. One build runs an older release (record version 1) and a newer
// one (record version 2): the version a worker or a takeover writes and compares is a parameter.

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

/**
 * A producer of release `version` recording at `at`: write the record, then start a worker of its release when the
 * lock check calls for one, as Q1b's hook will.
 */
async function produce(version: number, at: number, body: RecordBody, worker: Partial<WorkerOptions> = {}) {
  const produced = await produceRecord(home.statePath, body, { version, clock: { now: () => at } });
  if (produced.status === 'recorded' && produced.startWorker) {
    void pool.start(version, worker);
  }
  return produced;
}

async function requestFiles(): Promise<string[]> {
  const prefix = basename(queuePaths(home.statePath).stopRequestPrefix);
  return (await readdir(home.dir)).filter((name) => name.startsWith(prefix));
}

/** Counts the waits between a worker's iterations, to show it stops at the first iteration after an event. */
function countedDelay(): { delay: Delay; count: () => number } {
  let calls = 0;
  return {
    delay: (ms, signal) => {
      calls += 1;
      return vt.delay(ms, signal);
    },
    count: () => calls
  };
}

function takeoverOptions(version: number, startWorker: () => void = () => undefined) {
  return { version, clock: vt.clock, monotonic: vt.monotonic, delay: vt.delay, effects: fake.effects, startWorker };
}

describe('upgrades between queue releases', () => {
  it('an older worker in a slow publish applies the older records, leaves at the newer one starting no worker, and the newer worker applies the rest', async () => {
    const base = vt.clock.now();
    const publish = fake.holdPublishes();
    const olderDelay = countedDelay();
    await recordAt(home.statePath, base, eventBody('SessionStart', 'first'));
    const older = pool.start(OLDER, { delay: olderDelay.delay });
    await publish.started;

    // Records of both releases arrive, the older ones first; the newer producer finds the older holder's version.
    await recordAt(home.statePath, base + 1, eventBody('SessionStart', 'a'), { version: OLDER });
    const iterationsBefore = olderDelay.count();
    expect(await produce(NEWER, base + 2, eventBody('Stop', 'a'))).toMatchObject({ startWorker: true });
    await recordAt(home.statePath, base + 3, eventBody('UserPromptSubmit', 'a'), { version: OLDER });

    expect(await older).toBe('newer-record');
    expect(olderDelay.count() - iterationsBefore).toBeLessThanOrEqual(2);
    await publish.aborted;
    expect(await pool.settled()).toEqual(['newer-record', 'idle']);

    // In order: started, finished by the newer record, then reopened by the older record after it.
    expect((await readState(home.statePath)).sessions.a).toMatchObject({
      status: 'running',
      startedAt: base + 3,
      lastHeartbeatAt: base + 3
    });
    expect((await listQueue(home.statePath)).records).toEqual([]);
    expect(await requestFiles()).toEqual([]);
    // The newer worker ran the sync the older one left owed when its publish was aborted.
    expect(fake.published).toHaveLength(1);
  });

  it('an older worker that took the lock after a newer one left hands a newer record to a newer worker', async () => {
    await recordAt(home.statePath, vt.clock.now(), eventBody('SessionStart', 'n1'), { version: NEWER });
    expect(await pool.start(NEWER)).toBe('idle');
    // The newer worker deleted its version, so a newer producer cannot mistake an older holder for it.
    expect(await readWorkerVersion(home.statePath)).toBe(0);

    const olderDelay = countedDelay();
    await produce(OLDER, vt.clock.now(), eventBody('SessionStart', 'o1'), { delay: olderDelay.delay, idleMs: 60_000 });
    await until(async () => 'o1' in (await readState(home.statePath)).sessions, 'the older worker applying');
    expect(await readWorkerVersion(home.statePath)).toBe(OLDER);

    const iterationsBefore = olderDelay.count();
    expect(await produce(NEWER, vt.clock.now(), eventBody('SessionStart', 'n2'))).toMatchObject({ startWorker: true });

    expect(await pool.settled()).toEqual(['idle', 'newer-record', 'idle']);
    expect(olderDelay.count() - iterationsBefore).toBeLessThanOrEqual(2);
    expect(Object.keys((await readState(home.statePath)).sessions).sort()).toEqual(['n1', 'n2', 'o1']);
  });
});

describe('an older holder after a newer one', () => {
  const laterAgentRefresh = {
    source: 'later-agent',
    scanEnv: { LATER_HOME: '/fake-home/later' },
    boundaryAt: T0,
    generation: 3,
    reason: 'boundary'
  };
  const laterOwed = { usageRefresh: [laterAgentRefresh], laterKind: [{ anything: { nested: [1, 'two'] } }] };

  it('an older command applies its records, writes back the owed work it cannot do, and starts no worker for it', async () => {
    await writeState(home.statePath, { sessions: {}, queueOwed: laterOwed });
    const skip = await recordAt(
      home.statePath,
      T0,
      { kind: 'skip', code: 'ignored-event', source: 'pi', nativeEvent: 'session_start', payloadKeys: [] },
      { version: OLDER }
    );
    let starts = 0;

    await takeOver(
      home.statePath,
      async (takeover) => {
        await takeover.applyPending();
        await takeover.workOffOwed(['dshUsage']);
      },
      takeoverOptions(OLDER, () => {
        starts += 1;
      })
    );

    expect(starts).toBe(0);
    const raw = await readRawState(home.statePath);
    expect(raw.queueOwed).toEqual(laterOwed);
    expect(raw.queueApplied).toEqual([skip]);
  });

  it('an older worker holding the lock with only that work owed exits when idle and leaves it as it was', async () => {
    await writeState(home.statePath, { sessions: {}, queueOwed: laterOwed });

    expect(await pool.start(OLDER)).toBe('idle');

    expect((await readRawState(home.statePath)).queueOwed).toEqual(laterOwed);
    expect(fake.refreshed).toEqual([]);
  });

  it('an older worker works off the refresh of a source it has without a scanner and leaves one of a source it lacks', async () => {
    await writeState(home.statePath, {
      sessions: {},
      queueOwed: { usageRefresh: [{ source: 'grok', scanEnv: {}, boundaryAt: T0, generation: 1 }, laterAgentRefresh] }
    });

    expect(await pool.start(OLDER)).toBe('idle');

    expect(fake.refreshed.map(({ source, boundaryAt }) => ({ source, boundaryAt }))).toEqual([
      { source: 'grok', boundaryAt: T0 }
    ]);
    expect((await readRawState(home.statePath)).queueOwed).toEqual({ usageRefresh: [laterAgentRefresh] });
  });

  it('an older command applies no record whose id a newer worker saved before it was killed', async () => {
    await recordAt(home.statePath, T0 + 1_000, eventBody('SessionStart', 'a'), { version: OLDER });
    await recordAt(home.statePath, T0 + 2_000, eventBody('SessionStart', 'b'), { version: NEWER });
    // No session `z`: finishes the latest running session, `b`.
    await recordAt(home.statePath, T0 + 3_000, eventBody('Stop', 'z'), { version: NEWER });
    const killed = applyQueueBatch(home.statePath, {
      version: NEWER,
      config: await loadConfig(),
      clock: vt.clock,
      onStep: async (step) => {
        if (step === 'saved') {
          throw new Error('killed after the save');
        }
      }
    });
    await expect(killed).rejects.toThrow('killed after the save');
    const saved = await readState(home.statePath);
    await recordAt(home.statePath, T0 + 4_000, eventBody('SessionStart', 'c'), { version: OLDER });

    await takeOver(home.statePath, (takeover) => takeover.applyPending(), takeoverOptions(OLDER));

    const state = await readState(home.statePath);
    expect(state.sessions.a).toEqual(saved.sessions.a);
    expect(state.sessions.b).toEqual(saved.sessions.b);
    expect(state.sessions.b).toMatchObject({ status: 'finished', finishedAt: T0 + 3_000 });
    expect(state.sessions.c).toMatchObject({ status: 'running', startedAt: T0 + 4_000 });
    expect((await listQueue(home.statePath)).records).toEqual([]);
  });
});
