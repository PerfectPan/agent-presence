import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import * as nodeModule from 'node:module';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProcessLock } from '@rivus/agent-kit-collab/process-lock';
import { afterEach, beforeEach, describe, expect, it, type TestContext } from 'vite-plus/test';
import { acquireLock } from '../src/process-lock.js';
import { readWorkerVersion } from '../src/queue/files.js';
import { produceRecord } from '../src/queue/produce.js';
import { listQueue } from '../src/queue/reader.js';
import { runWorker } from '../src/queue/worker.js';
import { readUsageEvents } from '../src/usage-events-log.js';
import {
  createQueueHome,
  dshUsage,
  eventBody,
  fakeEffects,
  readState,
  recordAt,
  T0,
  virtualTime,
  type QueueHome
} from './queue-support.js';

// Plan 0003 5.2 and Spec S4: a worker killed with SIGKILL at each point of its work leaves the next worker to apply
// every record once, append every dsh usage line once, and refresh every owed source once. The worker runs in a child
// process, which reports reaching the point on stdout and is killed there; the tests wait on those lines only.

// The child needs `--experimental-transform-types` and this Node's `registerHooks` (both added in 22.15) to run the
// TypeScript sources, while `engines` still allows 22.13: on such a Node the tests skip instead of failing.
const canRunTypeSources = typeof nodeModule.registerHooks === 'function';

/** Skips the crash tests where the child cannot run the TypeScript sources. */
function skipWithoutRegisterHooks({ skip }: TestContext): void {
  skip(
    !canRunTypeSources,
    'this Node cannot run the TypeScript sources in a child: module.registerHooks is missing (added in Node 22.15, while engines still allows 22.13)'
  );
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = (path: string): string => pathToFileURL(resolve(repoRoot, path)).href;

// Runs the TypeScript sources as they are: Node strips the types, and the hook maps the `.js` specifiers the sources
// use onto their `.ts` files. The worker stops for good at the point named in argv[2].
const childScript = `
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw error;
    }
  }
});
const [statePath, stopAt] = process.argv.slice(1, 3);
const { runWorker } = await import(${JSON.stringify(moduleUrl('src/queue/worker.ts'))});
const { appendUsageEvent } = await import(${JSON.stringify(moduleUrl('src/usage-events-log.ts'))});
const { loadState, saveState, withStateLock } = await import(${JSON.stringify(moduleUrl('src/state-store.ts'))});
const say = (line) => process.stdout.write(line + '\\n');
const stopHere = (line) => {
  say(line);
  return new Promise(() => {});
};
// A forever-pending await does not keep a Node process alive: without a live handle the frozen worker would exit
// itself and the kernel would drop its worker lock, instead of staying at the point until the test kills it.
setInterval(() => undefined, 10_000);
await runWorker({
  statePath,
  idleMs: 3_600_000,
  startWorker: () => {},
  onBatchStep: async (step) => {
    if (step === stopAt) {
      await stopHere('at ' + step);
    }
  },
  effects: {
    appendUsage: async (usage, id, signal) => {
      if (stopAt === 'append') {
        say('appending');
      }
      return appendUsageEvent(usage, { id, signal });
    },
    refreshUsage: async (request) => {
      if (stopAt === 'refresh') {
        await stopHere('refreshing ' + request.source);
      }
      await withStateLock(request.statePath, async () => {
        const state = await loadState(request.statePath);
        request.onSave(state);
        await saveState(state, request.statePath);
      });
      return { completed: true };
    },
    publish: async () => {}
  }
});
`;

let home: QueueHome;
let child: ChildProcessWithoutNullStreams | undefined;
let usageLogWriter: ProcessLock | undefined;

beforeEach(async () => {
  home = await createQueueHome();
});

afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await usageLogWriter?.release();
  usageLogWriter = undefined;
  await home.dispose();
});

/** Start the worker in a child process and resolve once it printed `line`; it inherits this test's presence home. */
async function startChildUntil(stopAt: string, line: string): Promise<ChildProcessWithoutNullStreams> {
  const started = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      childScript,
      home.statePath,
      stopAt
    ],
    { cwd: repoRoot }
  );
  child = started;
  const lines = createInterface({ input: started.stdout });
  const exited = once(started, 'exit').then(([code, signal]: unknown[]) => {
    throw new Error(`the worker exited before "${line}": ${String(code)} ${String(signal)}`);
  });
  const reached = (async () => {
    for await (const printed of lines) {
      if (printed === line) {
        return;
      }
    }
  })();
  await Promise.race([reached, exited]);
  return started;
}

async function kill(process: ChildProcessWithoutNullStreams): Promise<void> {
  const exited = once(process, 'exit');
  process.kill('SIGKILL');
  await exited;
  child = undefined;
}

/** Records whose double application shows: a fallback finish, a dsh usage event, and a boundary that owes a refresh. */
async function recordWork(): Promise<void> {
  await recordAt(home.statePath, T0 + 1_000, eventBody('SessionStart', 'a'));
  await recordAt(home.statePath, T0 + 2_000, eventBody('SessionStart', 'b'));
  // No session `z`: finishes the latest running session, `b`; applied twice it would finish `a` too.
  await recordAt(home.statePath, T0 + 3_000, eventBody('Stop', 'z'));
  await recordAt(
    home.statePath,
    T0 + 4_000,
    eventBody('Heartbeat', 'd', { source: 'dsh', usage: dshUsage, payloadKeys: ['usage'] })
  );
  await recordAt(
    home.statePath,
    T0 + 5_000,
    eventBody('SessionStart', 'c', { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/claude' } })
  );
}

/** The next worker, in process; it finishes what the killed one left. */
async function nextWorker() {
  const vt = virtualTime(T0 + 60_000);
  const fake = fakeEffects();
  const reason = await runWorker({
    statePath: home.statePath,
    clock: vt.clock,
    monotonic: vt.monotonic,
    delay: vt.delay,
    effects: fake.effects,
    idleMs: 0,
    startWorker: () => undefined
  });
  return { reason, fake };
}

async function expectEverythingOnce(refreshedByNextWorker: string[]): Promise<void> {
  const state = await readState(home.statePath);
  expect(state.sessions.a).toMatchObject({ status: 'running', startedAt: T0 + 1_000 });
  expect(state.sessions.b).toMatchObject({ status: 'finished', finishedAt: T0 + 3_000 });
  expect(state.sessions.c).toMatchObject({ status: 'running' });
  expect(state.sessions.d).toMatchObject({ status: 'running' });
  expect(await readUsageEvents('dsh', 0, T0 + 10_000)).toHaveLength(1);
  expect(state.queueOwed?.dshUsage ?? []).toEqual([]);
  expect(state.queueOwed?.usageRefresh ?? []).toEqual([]);
  // One owed refresh per source and scanEnv, each done once.
  expect(refreshedByNextWorker.sort()).toEqual(['claude', 'codex']);
  expect((await listQueue(home.statePath)).records).toEqual([]);
}

describe('a worker killed with SIGKILL', () => {
  for (const step of ['read', 'saved', 'deleted'] as const) {
    it(`after the batch step "${step}" leaves the next worker to finish everything once`, async (ctx) => {
      skipWithoutRegisterHooks(ctx);
      await recordWork();
      const worker = await startChildUntil(step, `at ${step}`);
      await kill(worker);
      // The kernel released its lock; its version stays until the next holder overwrites it.
      expect(await readWorkerVersion(home.statePath)).toBe(1);

      const { reason, fake } = await nextWorker();

      expect(reason).toBe('idle');
      expect(await readWorkerVersion(home.statePath)).toBe(0);
      await expectEverythingOnce(fake.refreshed.map(({ source }) => source));
    }, 30_000);
  }

  it('during a usage refresh leaves it owed, and the next worker refreshes the source once', async (ctx) => {
    skipWithoutRegisterHooks(ctx);
    await recordWork();
    const worker = await startChildUntil('refresh', 'refreshing codex');
    await kill(worker);

    const { reason, fake } = await nextWorker();

    expect(reason).toBe('idle');
    await expectEverythingOnce(fake.refreshed.map(({ source }) => source));
  }, 30_000);

  it('during a dsh usage append that waits for the usage log leaves it owed, and the line is written once', async (ctx) => {
    skipWithoutRegisterHooks(ctx);
    await recordWork();
    // Another writer holds the usage log, so the append waits for its lock.
    usageLogWriter = await acquireLock(`${home.usageEventsPath}.lock.db`, AbortSignal.timeout(5_000));
    const worker = await startChildUntil('append', 'appending');
    await kill(worker);
    await usageLogWriter.release();
    usageLogWriter = undefined;

    const { reason, fake } = await nextWorker();

    expect(reason).toBe('idle');
    expect(fake.appended).toHaveLength(1);
    await expectEverythingOnce(fake.refreshed.map(({ source }) => source));
  }, 30_000);

  it('while a producer writes leaves the record to the next producer, which starts a worker that applies everything once', async (ctx) => {
    skipWithoutRegisterHooks(ctx);
    await recordWork();
    const worker = await startChildUntil('read', 'at read');
    // The producer records while the holder still holds the lock and has written its version: it starts no worker.
    const during = await produceRecord(home.statePath, eventBody('SessionStart', 'late'), {
      clock: { now: () => T0 + 6_000 }
    });
    expect(during).toMatchObject({ status: 'recorded', startWorker: false });
    await kill(worker);

    // The next producer finds the lock free and starts a worker, which applies every record once.
    const next = await produceRecord(home.statePath, eventBody('SessionStart', 'later'), {
      clock: { now: () => T0 + 7_000 }
    });
    expect(next).toMatchObject({ status: 'recorded', startWorker: true });

    const { reason, fake } = await nextWorker();

    expect(reason).toBe('idle');
    expect(await readWorkerVersion(home.statePath)).toBe(0);
    await expectEverythingOnce(fake.refreshed.map(({ source }) => source));
    const state = await readState(home.statePath);
    expect(state.sessions.late).toMatchObject({ status: 'running', startedAt: T0 + 6_000 });
    expect(state.sessions.later).toMatchObject({ status: 'running', startedAt: T0 + 7_000 });
  }, 30_000);
});
