// Shared by the Q1b command tests: a queue home on virtual time with fake owed-work effects and a worker pool, the
// takeover seam the tests pass to the commands, and stdout capture. Kept out of queue-support.ts so part A's edits
// there do not conflict. Nothing here waits on the wall clock.
import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { vi } from 'vite-plus/test';
import type { AppConfig } from '../src/config.js';
import { queuePaths } from '../src/queue/files.js';
import type { StartWorker } from '../src/queue/start-worker.js';
import type { TakeoverOptions } from '../src/queue/takeover.js';
import {
  createQueueHome,
  createWorkerPool,
  fakeEffects,
  virtualTime,
  type FakeEffects,
  type QueueHome,
  type VirtualTime,
  type WorkerPool
} from './queue-support.js';

/** The render templates the command tests configure, so a rendered value is exact. */
export const TEMPLATES = { zero: 'ZERO', one: 'ONE {details}', many: 'MANY {details}' };

export interface CommandHarness {
  readonly home: QueueHome;
  readonly vt: VirtualTime;
  readonly fake: FakeEffects;
  readonly pool: WorkerPool;
  /** The takeover seam for a command run: virtual time, fake effects, and leaving workers started in the pool. */
  takeoverOptions(extra?: TakeoverOptions): TakeoverOptions;
  /** A `startWorker` that only counts, for a command whose leaving worker the test does not run. */
  countingStarts(): { count(): number; startWorker: StartWorker };
  /** The stop-request files next to the state file, live or not. */
  requestFiles(): Promise<string[]>;
  dispose(): Promise<void>;
}

/** A home whose config renders usage off and whose templates are the exact ones above. */
export async function createCommandHarness(
  config: AppConfig = { provider: 'feishu-signature', render: TEMPLATES }
): Promise<CommandHarness> {
  const home = await createQueueHome();
  await home.writeConfig(config);
  const vt = virtualTime();
  const fake = fakeEffects();
  const pool = createWorkerPool({
    statePath: home.statePath,
    clock: vt.clock,
    monotonic: vt.monotonic,
    delay: vt.delay,
    isPidAlive: () => true,
    effects: fake.effects,
    idleMs: 1_000
  });
  return {
    home,
    vt,
    fake,
    pool,
    takeoverOptions(extra = {}) {
      return {
        clock: vt.clock,
        monotonic: vt.monotonic,
        delay: vt.delay,
        effects: fake.effects,
        startWorker: pool.starter(),
        ...extra
      };
    },
    countingStarts() {
      let count = 0;
      return {
        count: () => count,
        startWorker: () => {
          count += 1;
        }
      };
    },
    async requestFiles() {
      const prefix = basename(queuePaths(home.statePath).stopRequestPrefix);
      return (await readdir(home.dir)).filter((name) => name.startsWith(prefix));
    },
    dispose: async () => {
      await pool.stop();
      await home.dispose();
    }
  };
}

export interface PrintCapture {
  /** One entry per `console.log` call, with its parts joined by spaces. */
  readonly lines: string[];
  restore(): void;
}

/** Capture what a command prints, so a test can pin the printed output. */
export function capturePrint(): PrintCapture {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(' '));
  });
  return {
    lines,
    restore: () => log.mockRestore()
  };
}

/** Pin the command bodies' `Date.now` to `at`; restore it with the returned function. */
export function mockNow(at: number): () => void {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(at);
  return () => spy.mockRestore();
}

/** `Date.now` the test moves between the command's reads, so a record can be newer than its first read. */
export function movableNow(at: number): { set(next: number): void; restore(): void } {
  let current = at;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => current);
  return {
    set: (next: number) => {
      current = next;
    },
    restore: () => spy.mockRestore()
  };
}
