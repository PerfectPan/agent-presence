// Shared by the queue worker and takeover tests: virtual time, a temporary presence home, record bodies, and fake
// effects for owed work. Nothing here waits on the wall clock.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessLockPlatform } from '@rivus/agent-kit-collab/process-lock';
import type { AppConfig } from '../src/config.js';
import { kitPlatform } from '../src/kit-platform.js';
import type { UsageRefreshOutcome } from '../src/cli/usage-badge.js';
import { writeTombstone, type QueueClock } from '../src/queue/files.js';
import type { OwedWorkEffects, UsageRefreshRequest } from '../src/queue/follow-up.js';
import { writeRecord, type RecordBody } from '../src/queue/produce.js';
import type { StartWorker } from '../src/queue/start-worker.js';
import type { Delay } from '../src/queue/stop-request.js';
import { runWorker, type WorkerExitReason, type WorkerOptions } from '../src/queue/worker.js';
import type { PresenceState } from '../src/state.js';
import { loadState, saveState, withStateLock } from '../src/state-store.js';

export const T0 = 1_760_000_000_000;

export interface VirtualTime {
  /** The wall clock: it moves with the timers, and `jump` moves it alone. */
  readonly clock: QueueClock;
  /** Monotonic time, which only the timers move. */
  readonly monotonic: QueueClock;
  /** Resolves once virtual time reaches its end, or at once when `signal` aborts. */
  readonly delay: Delay;
  /** Move the wall clock alone, as a sleep or a clock change does; timers are not affected. */
  jump(ms: number): void;
}

/**
 * Time that passes only through timers: while a timer is pending, time moves to the earliest one at each tick of the
 * event loop's timer phase and resolves the timers due then. Every actor in a test (workers, commands, request
 * touches) waits on these timers, so the 250 ms rounds, the 2-second touches, the 60-second limit and the idle
 * interval keep their order without any wall-clock wait. Work that does not wait on a timer (file and lock I/O) takes
 * as much virtual time as other actors' timers move it meanwhile, a few steps at most; ticking in the timer phase
 * rather than at every turn keeps that small, since a turn with pending callbacks does not wait for I/O.
 */
export function virtualTime(start = T0): VirtualTime {
  let mono = 0;
  let wallOffset = start;
  let scheduled = false;
  const timers = new Set<{ at: number; fire: () => void }>();

  function schedule(): void {
    if (scheduled || timers.size === 0) {
      return;
    }
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (timers.size === 0) {
        return;
      }
      mono = Math.max(mono, Math.min(...[...timers].map((timer) => timer.at)));
      for (const timer of timers) {
        if (timer.at <= mono) {
          timers.delete(timer);
          timer.fire();
        }
      }
      schedule();
    }, 0);
  }

  const delay: Delay = (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = { at: mono + ms, fire: (): void => undefined };
      const onAbort = (): void => {
        timers.delete(timer);
        resolve();
      };
      timer.fire = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      timers.add(timer);
      schedule();
    });

  return {
    clock: { now: () => wallOffset + mono },
    monotonic: { now: () => mono },
    delay,
    jump: (ms) => {
      wallOffset += ms;
    }
  };
}

export interface QueueHome {
  readonly dir: string;
  readonly statePath: string;
  readonly usageEventsPath: string;
  readonly logPath: string;
  writeConfig(config: AppConfig): Promise<void>;
  dispose(): Promise<void>;
}

const HOME_VARIABLES = ['AGENT_PRESENCE_HOME', 'AGENT_PRESENCE_CONFIG_FILE'] as const;

/**
 * A temporary presence home for one test, with its own config file (so no legacy config under the real home is read)
 * rendering usage in the signature, so boundaries owe refreshes.
 */
export async function createQueueHome(): Promise<QueueHome> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-presence-queue-'));
  const saved = HOME_VARIABLES.map((name) => [name, process.env[name]] as const);
  const configPath = join(dir, 'config.json');
  process.env.AGENT_PRESENCE_HOME = dir;
  process.env.AGENT_PRESENCE_CONFIG_FILE = configPath;
  const home: QueueHome = {
    dir,
    statePath: join(dir, 'state.json'),
    usageEventsPath: join(dir, 'usage-events.log'),
    logPath: join(dir, 'agent-presence.log'),
    writeConfig: (config) => writeFile(configPath, JSON.stringify(config)),
    dispose: async () => {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  };
  await home.writeConfig({ provider: 'feishu-signature', usage: { showInSignature: true } });
  return home;
}

export function eventBody(
  event: string,
  sessionId: string,
  extra: Partial<Extract<RecordBody, { kind: 'event' }>> = {}
): RecordBody {
  return { kind: 'event', source: 'codex', event, sessionId, payloadKeys: ['session_id'], ...extra };
}

export const dshUsage = {
  source: 'dsh',
  model: 'deepseek-v4-pro',
  timestamp: T0,
  inputTokens: 900,
  outputTokens: 100,
  cacheWriteTokens: 0,
  cacheReadTokens: 2000
};

/** Write a record recorded at `at` with record version `version` (1 by default) and the current epoch 0. */
export function recordAt(
  statePath: string,
  at: number,
  body: RecordBody,
  options: { version?: number; epoch?: number } = {}
): Promise<string> {
  return writeRecord(statePath, body, {
    epoch: options.epoch ?? 0,
    version: options.version ?? 1,
    clock: { now: () => at }
  });
}

export async function readState(statePath: string): Promise<PresenceState> {
  return loadState(statePath);
}

export async function writeState(statePath: string, raw: unknown): Promise<void> {
  await writeFile(statePath, JSON.stringify(raw), { mode: 0o600 });
}

export async function readRawState(statePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
}

/** Resolves once `ready` holds, checking at every turn of the event loop; for evidence that comes from I/O. */
export async function until(ready: () => boolean | Promise<boolean>, what = 'the condition'): Promise<void> {
  // Bounded by turns, not time: a test that never gets there fails instead of hanging.
  for (let turn = 0; turn < 2_000_000; turn += 1) {
    if (await ready()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`never reached ${what}`);
}

/** Let a random number of event-loop turns, up to `max`, pass: the random delays of the race tests. */
export async function randomTurns(max = 40): Promise<void> {
  const turns = Math.floor(Math.random() * max);
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export interface FakeEffects {
  readonly effects: OwedWorkEffects;
  readonly appended: Array<{ id: string; usage: unknown }>;
  readonly refreshed: UsageRefreshRequest[];
  readonly published: string[];
  /** Make the next refresh wait until `release()` or its abort; `started` resolves once it is waiting. */
  holdRefreshes(): { started: Promise<UsageRefreshRequest>; release: () => void };
  /** Make the next publish wait until its abort; `started` resolves once it is waiting. */
  holdPublishes(): { started: Promise<string>; aborted: Promise<void> };
  /** Make publishes fail. */
  failPublishes(): void;
}

/**
 * Owed-work effects that touch no transcript and no network. A refresh saves through its `onSave` the way the real
 * one does, so a refresh that completes changes the state in the same save. Appends go to the real usage events log in
 * the test's home unless `appendUsage` is replaced.
 */
export function fakeEffects(appendUsage?: OwedWorkEffects['appendUsage']): FakeEffects {
  const appended: Array<{ id: string; usage: unknown }> = [];
  const refreshed: UsageRefreshRequest[] = [];
  const published: string[] = [];
  let refreshGate: { onStart: (request: UsageRefreshRequest) => void; released: Promise<void> } | undefined;
  let publishGate: { onStart: (value: string) => void; onAbort: () => void } | undefined;
  let publishFails = false;

  async function refreshUsage(request: UsageRefreshRequest): Promise<UsageRefreshOutcome> {
    refreshed.push(request);
    if (refreshGate) {
      const gate = refreshGate;
      refreshGate = undefined;
      gate.onStart(request);
      const aborted = new Promise<'aborted'>((resolve) => {
        request.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
      if ((await Promise.race([gate.released.then(() => 'released' as const), aborted])) === 'aborted') {
        return { completed: false };
      }
    }
    await withStateLock(request.statePath, async () => {
      const state = await loadState(request.statePath);
      request.onSave(state);
      await saveState(state, request.statePath);
    });
    return { completed: true };
  }

  async function publish(value: string, _config: AppConfig, signal: AbortSignal): Promise<void> {
    if (publishFails) {
      throw new Error('provider unavailable');
    }
    if (publishGate) {
      const gate = publishGate;
      publishGate = undefined;
      gate.onStart(value);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      gate.onAbort();
      throw signal.reason;
    }
    published.push(value);
  }

  const effects: OwedWorkEffects = {
    appendUsage:
      appendUsage ??
      (async (usage, id, signal) => {
        const { appendUsageEvent } = await import('../src/usage-events-log.js');
        const written = await appendUsageEvent(usage, { id, signal });
        if (written) {
          appended.push({ id, usage });
        }
        return written;
      }),
    refreshUsage,
    publish
  };

  return {
    effects,
    appended,
    refreshed,
    published,
    holdRefreshes() {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<UsageRefreshRequest>((resolve) => {
        refreshGate = { onStart: resolve, released };
      });
      return { started, release };
    },
    holdPublishes() {
      let onAbort: () => void = () => undefined;
      const aborted = new Promise<void>((resolve) => {
        onAbort = resolve;
      });
      const started = new Promise<string>((resolve) => {
        publishGate = { onStart: resolve, onAbort };
      });
      return { started, aborted };
    },
    failPublishes() {
      publishFails = true;
    }
  };
}

export interface WorkerPool {
  /** Start a worker of `version` (1 by default) in process; the workers it starts when it leaves start the same way. */
  start(version?: number, extra?: Partial<WorkerOptions>): Promise<WorkerExitReason>;
  /** Every worker started so far, those started by leaving workers and commands included. */
  readonly runs: Array<Promise<WorkerExitReason>>;
  /** How many workers leaving workers and commands started through `starter`. */
  startedByLeavers(): number;
  /** A `startWorker` that starts a worker of `version` in process. */
  starter(version?: number): StartWorker;
  /** Resolves with every worker's exit reason once all have exited, the ones started meanwhile included. */
  settled(): Promise<WorkerExitReason[]>;
  /** Write the tombstone so that every worker exits, and wait for them. */
  stop(): Promise<void>;
}

/** In-process workers sharing `defaults`, which name the state file, the time and the effects. */
export function createWorkerPool(defaults: Omit<WorkerOptions, 'version'>): WorkerPool {
  const runs: Array<Promise<WorkerExitReason>> = [];
  let started = 0;
  function start(version = 1, extra: Partial<WorkerOptions> = {}): Promise<WorkerExitReason> {
    const startWorker: StartWorker = () => {
      started += 1;
      void start(version);
    };
    const run = runWorker({ startWorker, ...defaults, ...extra, version });
    runs.push(run);
    return run;
  }
  function starter(version = 1): StartWorker {
    return () => {
      started += 1;
      void start(version);
    };
  }
  async function settled(): Promise<WorkerExitReason[]> {
    let count = -1;
    while (count !== runs.length) {
      count = runs.length;
      await Promise.allSettled(runs);
    }
    return Promise.all(runs);
  }
  return {
    start,
    runs,
    startedByLeavers: () => started,
    starter,
    settled,
    async stop() {
      await writeTombstone(defaults.statePath);
      await settled().catch(() => undefined);
    }
  };
}

/**
 * The kit's platform with hooks on the worker lock's SQLite connections: `onTaken` runs right after an acquisition
 * took the lock and `onReleased` right after a held lock is released, both synchronously, before the caller goes on.
 */
export function hookedPlatform(hooks: { onTaken?: () => void; onReleased?: () => void }): ProcessLockPlatform {
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
