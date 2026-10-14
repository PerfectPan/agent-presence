import { setTimeout as sleep } from 'node:timers/promises';
import type { ProcessLockPlatform } from '@rivus/agent-kit-collab/process-lock';
import { loadConfig, type AppConfig } from '../config.js';
import { errorMessage } from '../cli/errors.js';
import { kitPlatform } from '../kit-platform.js';
import { writeLogEvent } from '../log.js';
import { loadState } from '../state-store.js';
import { applyQueueBatch, type BatchStep } from './apply.js';
import { isDisabled, RECORD_VERSION, systemClock, type QueueClock } from './files.js';
import {
  createOwedAttempts,
  defaultOwedWorkEffects,
  knownSources,
  workOffOwedItem,
  type OwedWorkEffects
} from './follow-up.js';
import { doableOwedItems } from './owed.js';
import { checkWorkerLock } from './produce.js';
import { listQueue, removeExpiredFiles } from './reader.js';
import { startWorkerProcess, type StartWorker } from './start-worker.js';
import { isPidAlive, liveStopRequests, type Delay, type PidAlive } from './stop-request.js';
import { holdWorkerLock, tryWorkerLock, type WorkerLockHold } from './worker-lock.js';

/** The apply lane's iteration and a started worker's round (Plan 0003 3.3, 3.5). */
export const WORKER_ROUND_MS = 250;
/** How long a started worker repeats its rounds before it gives up (3.3). */
export const STARTED_WORKER_WAIT_MS = 60_000;
/** How long a worker holds the lock with nothing to do before it leaves (3.6; decided by the owner). */
export const WORKER_IDLE_MS = 5 * 60_000;

/**
 * Why a worker exited (3.11):
 * - `idle`: the idle interval passed with nothing it could do, and its last listing found no record;
 * - `stop-request`: a command's live stop request;
 * - `newer-record`: its listing reached a record with a higher `v`;
 * - `tombstone`: `<state>.disabled` exists;
 * - `holder`: as a started worker, it found the lock held by a holder of its version or a newer one;
 * - `limit`: as a started worker, it gave up after `STARTED_WORKER_WAIT_MS`;
 * - `failing`: applying failed for a whole idle interval, for example on a state file it cannot write.
 */
export type WorkerExitReason = 'idle' | 'stop-request' | 'newer-record' | 'tombstone' | 'holder' | 'limit' | 'failing';

export interface WorkerOptions {
  readonly statePath: string;
  /** The record version this worker writes to `<state>.worker.v`, compares and applies up to; this release's. */
  readonly version?: number;
  /** The wall clock: stop-request ages, the rendered sync's `now`, failed-record dates. */
  readonly clock?: QueueClock;
  /** Elapsed time for the 60-second limit and the idle interval; `performance.now()` by default. */
  readonly monotonic?: QueueClock;
  /** Waits between rounds and iterations. */
  readonly delay?: Delay;
  readonly isPidAlive?: PidAlive;
  /** Starts a worker when this one leaves for a stop request; a detached `agent-presence worker` by default. */
  readonly startWorker?: StartWorker;
  readonly effects?: OwedWorkEffects;
  readonly idleMs?: number;
  readonly platform?: ProcessLockPlatform;
  /** Called at each step of an apply-lane batch; tests pause or kill the worker there. */
  readonly onBatchStep?: (step: BatchStep) => Promise<void>;
}

interface WorkerContext {
  readonly statePath: string;
  readonly version: number;
  readonly clock: QueueClock;
  readonly monotonic: QueueClock;
  readonly delay: Delay;
  readonly isPidAlive: PidAlive;
  readonly startWorker: StartWorker;
  readonly effects: OwedWorkEffects;
  readonly idleMs: number;
  readonly platform: ProcessLockPlatform;
  readonly onBatchStep: ((step: BatchStep) => Promise<void>) | undefined;
}

const monotonicClock: QueueClock = { now: () => performance.now() };
// The worker's own timer keeps its process alive between iterations.
const refDelay: Delay = (ms, signal) => sleep(ms, undefined, { signal }).catch(() => undefined);
const never = new AbortController().signal;

async function logQuietly(event: Record<string, unknown>): Promise<void> {
  try {
    await writeLogEvent(event);
  } catch {
    // Diagnostic only.
  }
}

function hasLiveStopRequest(context: WorkerContext): Promise<boolean> {
  return liveStopRequests(context.statePath, { clock: context.clock, isPidAlive: context.isPidAlive }).then(
    (requests) => requests.length > 0
  );
}

async function takeLockNow(context: WorkerContext): Promise<WorkerLockHold | undefined> {
  const lock = await tryWorkerLock(context.statePath, context.platform);
  return lock && holdWorkerLock(context.statePath, context.version, lock);
}

/** Whether owed work this release can do remains, the items this holder set aside included (3.5, 3.6). */
export async function owedWorkRemains(statePath: string): Promise<boolean> {
  const [state, config] = await Promise.all([loadState(statePath), loadConfig()]);
  return doableOwedItems(state.queueOwed, knownSources(config)).length > 0;
}

/** Whether the queue holds a record, counting a failed listing as one so that nothing is left behind. */
export async function recordsRemain(statePath: string): Promise<boolean> {
  try {
    return (await listQueue(statePath)).records.length > 0;
  } catch {
    return true;
  }
}

/**
 * A started worker's rounds (3.3): every `WORKER_ROUND_MS` for up to `STARTED_WORKER_WAIT_MS` it exits at the
 * tombstone, does nothing while a command's stop request is live, takes a free lock with one try, exits when the
 * holder's version is at least its own, and otherwise waits for the next round. It checks before it tries, so it never
 * pays a try against a held lock, and it never yields to another worker.
 */
async function waitForTheLock(context: WorkerContext): Promise<WorkerLockHold | WorkerExitReason> {
  const startedAt = context.monotonic.now();
  for (let round = 0; ; round += 1) {
    if (round > 0) {
      await context.delay(WORKER_ROUND_MS, never);
    }
    if (context.monotonic.now() - startedAt >= STARTED_WORKER_WAIT_MS) {
      return 'limit';
    }
    try {
      if (await isDisabled(context.statePath)) {
        return 'tombstone';
      }
      if (await hasLiveStopRequest(context)) {
        continue;
      }
      const lock = await checkWorkerLock(context.statePath, context.platform);
      if (!lock.held) {
        const hold = await takeLockNow(context);
        if (hold) {
          return hold;
        }
      } else if (lock.version >= context.version) {
        return 'holder';
      }
    } catch (error) {
      await logQuietly({ type: 'worker.round.failed', error: errorMessage(error) });
    }
  }
}

interface FollowUpLane {
  readonly busy: boolean;
  readonly lastActivityAt: number;
  /** Start working off owed items unless it already does; it ends when none it can do is left. */
  start(): void;
  hasWork(config: AppConfig): Promise<boolean>;
  renderedSyncOwedAgain(): void;
  /** Abort the item in progress and wait until it ended, with any rollback it triggered saved. */
  stop(): Promise<void>;
}

/** The follow-up lane (3.5): owed items one at a time, next to the apply lane, checking between items for a stop. */
function createFollowUpLane(context: WorkerContext): FollowUpLane {
  const controller = new AbortController();
  const attempts = createOwedAttempts();
  let running: Promise<void> | undefined;
  let lastActivityAt = context.monotonic.now();

  async function run(): Promise<void> {
    while (!controller.signal.aborted) {
      const [state, config] = await Promise.all([loadState(context.statePath), loadConfig()]);
      const item = attempts.next(state, knownSources(config));
      if (!item) {
        return;
      }
      const outcome = await workOffOwedItem(item, {
        statePath: context.statePath,
        config,
        clock: context.clock,
        effects: context.effects,
        signal: controller.signal
      });
      lastActivityAt = context.monotonic.now();
      if (outcome !== 'done') {
        attempts.setAside(item);
        await logQuietly({ type: 'worker.owed', kind: item.kind, result: outcome });
      } else if (item.kind === 'usageRefresh') {
        attempts.renderedSyncOwedAgain();
      }
    }
  }

  return {
    get busy() {
      return running !== undefined;
    },
    get lastActivityAt() {
      return lastActivityAt;
    },
    start() {
      if (running || controller.signal.aborted) {
        return;
      }
      running = run()
        .catch((error: unknown) => logQuietly({ type: 'worker.owed.failed', error: errorMessage(error) }))
        .finally(() => {
          running = undefined;
        });
    },
    async hasWork(config) {
      return attempts.next(await loadState(context.statePath), knownSources(config)) !== undefined;
    },
    renderedSyncOwedAgain: () => attempts.renderedSyncOwedAgain(),
    async stop() {
      controller.abort();
      await running;
    }
  };
}

type HoldEnd = 'idle' | 'stop-request' | 'newer-record' | 'tombstone' | 'failing';

/**
 * Hold the lock and apply: every `WORKER_ROUND_MS` check the tombstone and the stop requests, apply one batch, keep the
 * follow-up lane going, and leave when idle. Then stop the lane, note whether owed work remains, and release (3.6,
 * steps 1 and 2).
 */
async function applyWhileHolding(
  context: WorkerContext,
  hold: WorkerLockHold
): Promise<{ end: HoldEnd; owedRemains: boolean }> {
  const { statePath } = context;
  const removed = await removeExpiredFiles(statePath, context.clock).catch(() => undefined);
  if (removed && removed.temporary + removed.failed > 0) {
    await logQuietly({ type: 'queue.expired', ...removed });
  }
  const lane = createFollowUpLane(context);
  let lastAppliedAt = context.monotonic.now();
  let failingSince: number | undefined;
  let end: HoldEnd;
  for (;;) {
    try {
      if (await isDisabled(statePath)) {
        end = 'tombstone';
        break;
      }
      if (await hasLiveStopRequest(context)) {
        end = 'stop-request';
        break;
      }
      const config = await loadConfig();
      const batch = await applyQueueBatch(statePath, {
        version: context.version,
        config,
        clock: context.clock,
        onStep: context.onBatchStep
      });
      failingSince = undefined;
      if (batch.applied > 0) {
        lastAppliedAt = context.monotonic.now();
      }
      if (batch.appliedEvents) {
        lane.renderedSyncOwedAgain();
      }
      if (batch.newer) {
        end = 'newer-record';
        break;
      }
      const owedWork = await lane.hasWork(config);
      if (owedWork) {
        lane.start();
      }
      const quietFor = context.monotonic.now() - Math.max(lastAppliedAt, lane.lastActivityAt);
      if (batch.listed === 0 && !owedWork && !lane.busy && quietFor >= context.idleMs) {
        end = 'idle';
        break;
      }
    } catch (error) {
      await logQuietly({ type: 'worker.batch.failed', error: errorMessage(error) });
      failingSince ??= context.monotonic.now();
      if (context.monotonic.now() - failingSince >= context.idleMs) {
        end = 'failing';
        break;
      }
    }
    await context.delay(WORKER_ROUND_MS, never);
  }

  await lane.stop();
  const owedRemains = await owedWorkRemains(statePath).catch(() => true);
  await hold.release();
  return { end, owedRemains };
}

function resolveOptions(options: WorkerOptions): WorkerContext {
  return {
    statePath: options.statePath,
    version: options.version ?? RECORD_VERSION,
    clock: options.clock ?? systemClock,
    monotonic: options.monotonic ?? monotonicClock,
    delay: options.delay ?? refDelay,
    isPidAlive: options.isPidAlive ?? isPidAlive,
    startWorker: options.startWorker ?? startWorkerProcess,
    effects: options.effects ?? defaultOwedWorkEffects,
    idleMs: options.idleMs ?? WORKER_IDLE_MS,
    platform: options.platform ?? kitPlatform(),
    onBatchStep: options.onBatchStep
  };
}

async function workUntilExit(context: WorkerContext): Promise<WorkerExitReason> {
  let hold: WorkerLockHold | undefined;
  for (;;) {
    if (!hold) {
      const waited = await waitForTheLock(context);
      if (typeof waited === 'string') {
        return waited;
      }
      hold = waited;
    }
    const left = await applyWhileHolding(context, hold);
    hold = undefined;

    // Step 3 of leaving (3.6): list the queue once more.
    const records = await recordsRemain(context.statePath);
    if (left.end === 'idle') {
      if (!records) {
        return 'idle';
      }
      // A record renamed after the last batch: take the lock again, unless a command waits for it. A retake lost to
      // another process, or skipped for a request, continues as a started worker, since that holder may be older.
      const requested = await hasLiveStopRequest(context).catch(() => true);
      hold = requested ? undefined : await takeLockNow(context).catch(() => undefined);
      continue;
    }
    // A producer that renamed its record while this worker held the lock started no worker, and the requester may be
    // of an older release; the worker started here waits for the requester and exits once a holder of its version
    // or a newer one has written it (3.6). Leaving for a newer record or the tombstone starts none.
    if (left.end === 'stop-request' && (left.owedRemains || records)) {
      context.startWorker();
    }
    return left.end;
  }
}

/**
 * Run `agent-presence worker` for the state file (Plan 0003 3.3-3.7): start as a started worker, apply records and
 * work off owed items while holding the worker lock, and leave in 3.6's order. Resolves with the reason it exited.
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerExitReason> {
  const context = resolveOptions(options);
  await logQuietly({ type: 'worker.start', version: context.version });
  const reason = await workUntilExit(context);
  await logQuietly({ type: 'worker.exit', reason, version: context.version });
  return reason;
}
