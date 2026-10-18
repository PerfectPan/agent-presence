import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { hook } from '../src/cli/commands/hook.js';
import { setHookStartWorkerForTests } from '../src/cli/hook-output.js';
import type { AppConfig } from '../src/config.js';
import { listQueue } from '../src/queue/reader.js';
import {
  createQueueHome,
  createWorkerPool,
  fakeEffects,
  readState,
  virtualTime,
  type QueueHome,
  type VirtualTime,
  type WorkerPool
} from './queue-support.js';

// The concurrent-hook check: 100 hooks fire at once as the real hook command, each recording its
// event through the queue's producer with the worker start injected, and one worker applies every event.

// Each concurrent hook reads its own payload; the list doubles as the count of hooks that ran.
const payloads = vi.hoisted(() => ({
  remaining: [] as Array<Record<string, unknown>>
}));
// A rendered sync inside the debounce window schedules a detached flush; record it instead of forking vitest's
// process, the way the sibling queue tests do.
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

vi.mock('../src/cli/io.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/io.js')>('../src/cli/io.js');
  return {
    ...actual,
    readStdinJson: async () => {
      const payload = payloads.remaining.shift();
      if (payload === undefined) {
        throw new Error('no payload left for this hook');
      }
      return payload;
    }
  };
});

let home: QueueHome;
let vt: VirtualTime;
let pool: WorkerPool;

beforeEach(async () => {
  home = await createQueueHome();
  await home.writeConfig({ provider: 'feishu-signature' } satisfies AppConfig);
  vt = virtualTime();
  pool = createWorkerPool({
    statePath: home.statePath,
    clock: { now: () => Date.now() },
    monotonic: vt.monotonic,
    delay: vt.delay,
    isPidAlive: () => true,
    effects: fakeEffects().effects,
    idleMs: 1_000
  });
  // The producer's start runs a worker of the pool in this process instead of a detached one.
  setHookStartWorkerForTests(() => {
    void pool.start();
  });
});

afterEach(async () => {
  setHookStartWorkerForTests(undefined);
  await pool.stop();
  await home.dispose();
});

describe('100 concurrent hooks', () => {
  it('leave one worker applying every event', async () => {
    payloads.remaining = Array.from({ length: 100 }, (_, index) => ({ session_id: `s${index}` }));

    await Promise.all(
      Array.from({ length: 100 }, () => hook(['--source', 'claude', '--event', 'Heartbeat', '--silent']))
    );
    expect(payloads.remaining).toHaveLength(0);

    const reasons = await pool.settled();
    expect(reasons.filter((reason) => reason === 'idle')).toHaveLength(1);
    expect(reasons.filter((reason) => reason === 'holder')).toHaveLength(reasons.length - 1);

    const state = await readState(home.statePath);
    const sessions = Object.keys(state.sessions);
    expect(sessions).toHaveLength(100);
    expect(new Set(sessions).size).toBe(100);
    expect((await listQueue(home.statePath)).records).toEqual([]);
  }, 120_000);
});
