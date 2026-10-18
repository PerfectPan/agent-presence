import { setTimeout as sleep } from 'node:timers/promises';
import type { ProcessLockPlatform } from '@rivus/agent-kit-collab/process-lock';
import { loadValidatedConfig } from '../config-schema.js';
import { errorMessage } from '../cli/errors.js';
import { kitPlatform } from '../kit-platform.js';
import { LOG_LOCK_WAIT_MS } from '../log-retention.js';
import { writeLogEvent } from '../log.js';
import { loadState } from '../state-store.js';
import { applyQueueBatch, type BatchOutcome } from './apply.js';
import { isDisabled, RECORD_VERSION, systemClock, writeTombstone, type QueueClock } from './files.js';
import {
  createOwedAttempts,
  defaultOwedWorkEffects,
  knownSources,
  workOffOwedItem,
  type OwedWorkEffects
} from './follow-up.js';
import { ALL_OWED_KINDS, type OwedKind } from './owed.js';
import { startWorkerProcess, type StartWorker } from './start-worker.js';
import { holdStopRequest, type Delay } from './stop-request.js';
import { owedWorkRemains, recordsRemain } from './worker.js';
import { holdWorkerLock, waitForWorkerLock, type WorkerLockHold } from './worker-lock.js';

/** How long a command waits for the worker lock, in every release (Plan 0003 3.7). */
const TAKEOVER_WAIT_MS = 10_000;
/** How often a waiting command checks the lock and, when it is free, tries to take it. */
export const TAKEOVER_RETRY_MS = 50;

export interface TakeoverOptions {
  /** The record version the command writes to `<state>.worker.v` and applies up to; this release's. */
  readonly version?: number;
  /** The wall clock its stop request is dated by, and the rendered sync's `now`. */
  readonly clock?: QueueClock;
  /** Elapsed time for the wait; `performance.now()` by default. */
  readonly monotonic?: QueueClock;
  /** Waits between the request's touches and between tries for the lock. */
  readonly delay?: Delay;
  /** The pid the stop request holds; this process's by default. */
  readonly pid?: number;
  /** Starts a worker when the command leaves; a detached `agent-presence worker` by default. */
  readonly startWorker?: StartWorker;
  readonly effects?: OwedWorkEffects;
  readonly platform?: ProcessLockPlatform;
  readonly waitMs?: number;
  /** How long a command's dsh append waits for the log lock; the appends' default bound by default. */
  readonly logLockWaitMs?: number;
}

/** What a command that took over does with the queue before it runs its own code (3.7). */
export interface Takeover {
  /**
   * Whether the tombstone existed right after taking over. `status`, `reset`, `flush` and `update` then change nothing,
   * and nothing is applied (3.8).
   */
  readonly disabled: boolean;
  /** Apply the records listed now, up to the first with a higher `v` (apply-lane steps 1-3). */
  applyPending(): Promise<BatchOutcome>;
  /**
   * Work off the owed items of `kinds` this release can do, all of them by default, one attempt each; an item that
   * fails or aborts stays owed for the next worker. `status`, `flush` and `update` work off `dshUsage` only.
   */
  workOffOwed(kinds?: readonly OwedKind[], signal?: AbortSignal): Promise<void>;
}

interface TakeoverContext {
  readonly statePath: string;
  readonly version: number;
  readonly clock: QueueClock;
  readonly monotonic: QueueClock;
  readonly delay: Delay | undefined;
  readonly startWorker: StartWorker;
  readonly effects: OwedWorkEffects;
  readonly platform: ProcessLockPlatform;
  readonly logLockWaitMs: number;
}

const monotonicClock: QueueClock = { now: () => performance.now() };
const sleepDelay: Delay = (ms, signal) => sleep(ms, undefined, { signal }).catch(() => undefined);

async function logQuietly(event: Record<string, unknown>): Promise<void> {
  try {
    await writeLogEvent(event);
  } catch {
    // Diagnostic only.
  }
}

function createTakeover(context: TakeoverContext, disabled: boolean): Takeover {
  const { statePath } = context;
  return {
    disabled,
    async applyPending() {
      if (disabled) {
        return { listed: 0, applied: 0, appliedEvents: false, newer: false };
      }
      // The command process reports the config issues once (the run's first load printed them); this load only needs
      // the same validated view.
      return applyQueueBatch(statePath, {
        version: context.version,
        config: (await loadValidatedConfig()).config,
        clock: context.clock
      });
    },
    async workOffOwed(kinds = ALL_OWED_KINDS, signal?: AbortSignal) {
      if (disabled) {
        return;
      }
      const attempts = createOwedAttempts();
      // Off the hook path the log lock keeps the appends' bounded wait (Plan 0003 6.3): unlike the
      // worker's follow-up lane (3.5), no handover needs to stop a command's dsh append. One deadline from the call's
      // start bounds all of its dsh appends together, so a command with several owed entries waits `logLockWaitMs`
      // once; an append the deadline ends stays owed for the worker this command starts when it leaves (3.6). A
      // caller's signal replaces the deadline.
      const logLock = signal ?? AbortSignal.timeout(context.logLockWaitMs);
      for (;;) {
        const [state, { config }] = await Promise.all([loadState(statePath), loadValidatedConfig()]);
        const item = attempts.next(state, knownSources(config), kinds);
        if (!item) {
          return;
        }
        const outcome = await workOffOwedItem(item, {
          statePath,
          config,
          clock: context.clock,
          effects: context.effects,
          signal: item.kind === 'dshUsage' ? logLock : new AbortController().signal
        });
        attempts.setAside(item);
        if (outcome === 'done' && item.kind === 'usageRefresh') {
          attempts.renderedSyncOwedAgain();
        }
      }
    }
  };
}

/**
 * Leave as a command (3.6): note whether owed work remains, delete `<state>.worker.v` and release, list the queue once
 * more, and start a worker when owed work or a record remains, unless the tombstone exists. A producer that renamed its
 * record while the command held the lock read the command's version and started no worker, so this start is what gets
 * that record applied. Failures here never replace the command's own outcome.
 */
async function leave(context: TakeoverContext, hold: WorkerLockHold): Promise<void> {
  const owedRemains = await owedWorkRemains(context.statePath).catch(() => true);
  try {
    await hold.release();
  } catch (error) {
    await logQuietly({ type: 'takeover.release.failed', error: errorMessage(error) });
  }
  const start = owedRemains || (await recordsRemain(context.statePath));
  if (start && !(await isDisabled(context.statePath).catch(() => false))) {
    context.startWorker();
  }
}

/**
 * Take over from the worker for a command that changes state (Plan 0003 3.7): write a stop request and keep it live
 * while waiting up to `TAKEOVER_WAIT_MS` for the worker lock, then delete it, write `<state>.worker.v`, run `work`, and
 * leave in 3.6's order whether `work` succeeded or failed. A command that cannot take the lock in time rejects, as a
 * failed command does. A command that holds the lock never yields it to another request.
 */
export async function takeOver<T>(
  statePath: string,
  work: (takeover: Takeover) => Promise<T>,
  options: TakeoverOptions = {}
): Promise<T> {
  const context: TakeoverContext = {
    statePath,
    version: options.version ?? RECORD_VERSION,
    clock: options.clock ?? systemClock,
    monotonic: options.monotonic ?? monotonicClock,
    delay: options.delay,
    startWorker: options.startWorker ?? startWorkerProcess,
    effects: options.effects ?? defaultOwedWorkEffects,
    platform: options.platform ?? kitPlatform(),
    logLockWaitMs: options.logLockWaitMs ?? LOG_LOCK_WAIT_MS
  };

  const request = await holdStopRequest(statePath, { clock: context.clock, delay: options.delay, pid: options.pid });
  let lock;
  try {
    lock = await waitForWorkerLock(statePath, {
      platform: context.platform,
      monotonic: context.monotonic,
      delay: options.delay ?? sleepDelay,
      waitMs: options.waitMs ?? TAKEOVER_WAIT_MS,
      retryMs: TAKEOVER_RETRY_MS
    });
  } finally {
    await request.release();
  }

  const hold = await holdWorkerLock(statePath, context.version, lock);
  try {
    return await work(createTakeover(context, await isDisabled(statePath)));
  } finally {
    await leave(context, hold);
  }
}

/**
 * `agent-presence worker --stop` (3.8): take over, apply the pending records, work off the owed items, and write the
 * tombstone, so that hooks of this release record nothing and no worker starts until `setup` runs again. With the
 * tombstone already there it applies nothing.
 */
export async function stopWorker(statePath: string, options: TakeoverOptions = {}): Promise<void> {
  await takeOver(
    statePath,
    async (takeover) => {
      if (takeover.disabled) {
        return;
      }
      await takeover.applyPending();
      await takeover.workOffOwed();
      await writeTombstone(statePath);
    },
    options
  );
}
