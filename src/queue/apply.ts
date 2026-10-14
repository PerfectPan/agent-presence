import { join } from 'node:path';
import { ttlMs, type AppConfig } from '../config.js';
import { hookEventLogEvent } from '../cli/hook-diagnostics.js';
import { usageRenderPlan } from '../cli/usage-badge.js';
import { appendLogLines, errorLogLine, infoLogLine } from '../log.js';
import { applyAgentEvent, expireStaleSessions, type PresenceState } from '../state.js';
import { loadState, saveState, withStateLock } from '../state-store.js';
import { fileExists, queuePaths, readEpoch, RECORD_EXTENSION, type QueueClock } from './files.js';
import { addOwedWork } from './owed.js';
import { deleteQueueFile, listQueue, moveToFailed, readQueueFile, type QueueFile } from './reader.js';
import type { QueueRecord, SkipRecord } from './schema.js';

/** Above this many listed records the applier logs a backlog warning (Plan 0003 3.10). */
export const BACKLOG_WARNING_RECORDS = 10_000;

/**
 * The backlog-warning state of one applier run: the warning is logged once per run, and again only after the backlog
 * has fallen below the threshold (Plan 0003 3.10), so a holder reading every 250 ms does not log it every batch.
 */
export interface BacklogWarning {
  /** Whether a listing of `listed` records logs the warning now. */
  due(listed: number): boolean;
}

export function createBacklogWarning(): BacklogWarning {
  let warned = false;
  return {
    due(listed: number): boolean {
      if (listed <= BACKLOG_WARNING_RECORDS) {
        warned = false;
        return false;
      }
      if (warned) {
        return false;
      }
      warned = true;
      return true;
    }
  };
}

// A worker run is one process, so this warns once per run.
const processBacklogWarning = createBacklogWarning();

/** The points of a batch where tests pause or kill the applier: after reading, after the save, after deleting. */
export type BatchStep = 'read' | 'saved' | 'deleted';

export interface ApplyBatchOptions {
  /** The record version of the applier: it applies records up to this `v` and stops at a higher one. */
  readonly version: number;
  /** Read before each batch, as the worker reads the configuration file (Plan 0003 3.9). */
  readonly config: AppConfig;
  /** Dates the records moved to `failed/`. */
  readonly clock: QueueClock;
  /** The backlog-warning state; this process's by default (a worker run is one process, Plan 0003 3.10). */
  readonly backlogWarning?: BacklogWarning;
  /** Called at each step of the batch; tests pause or kill the applier there. */
  readonly onStep?: (step: BatchStep) => Promise<void>;
}

export interface BatchOutcome {
  /** Record files the listing found. */
  readonly listed: number;
  /** Records applied and saved by this batch. */
  readonly applied: number;
  /** Whether an applied record was an event, which owes a rendered sync. */
  readonly appliedEvents: boolean;
  /** The listing reached a record with a higher `v`; the records before it were applied and it was left in place. */
  readonly newer: boolean;
}

const NOTHING_LISTED: BatchOutcome = { listed: 0, applied: 0, appliedEvents: false, newer: false };

async function logQuietly(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    // Diagnostic only: a lost line never stops applying.
  }
}

function skipLine(record: SkipRecord): string {
  const source = record.source ?? record.agent;
  const agent = record.agent ?? record.source;
  // The codes this release writes (`KnownSkipCode`); a code of a later release is only logged.
  switch (record.code) {
    case 'missing-session-id':
      return `hook skipped: missing session id for source=${source} event=${record.nativeEvent}`;
    case 'no-presence-source':
      return `hook skipped: no presence source for agent=${agent} event=${record.nativeEvent}`;
    case 'ignored-event':
      return `hook skipped: ignored event source=${source} event=${record.nativeEvent}`;
    default:
      return `hook skipped: code=${record.code} source=${source} event=${record.nativeEvent}`;
  }
}

/**
 * The lines the hook wrote for this record before the queue: the event's diagnostic line, a skip, or a failure. A
 * `missing-session-id` skip keeps the diagnostic line the hook wrote before it found the session id missing — the
 * payload key names matter most there — ahead of the skip line.
 */
function recordLogLines(record: QueueRecord): string[] {
  switch (record.kind) {
    case 'event':
      return [
        infoLogLine(
          hookEventLogEvent({
            source: record.source,
            event: record.event,
            sessionId: record.sessionId,
            project: record.project,
            payloadKeys: record.payloadKeys
          })
        )
      ];
    case 'skip': {
      const skip = errorLogLine(skipLine(record));
      // The diagnostic line needs the source the hook named; this release always names one here.
      if (record.code !== 'missing-session-id' || record.source === undefined) {
        return [skip];
      }
      return [
        infoLogLine(
          hookEventLogEvent({
            source: record.source,
            event: record.nativeEvent,
            payloadKeys: record.payloadKeys
          })
        ),
        skip
      ];
    }
    case 'error':
      // An error record's message is the line the hook would have logged, without payload values.
      return [errorLogLine(record.message)];
  }
}

/** Apply one record to the loaded state at its recorded time, as the hook applied its event (Plan 0003 3.5). */
function applyRecord(state: PresenceState, record: QueueRecord, config: AppConfig, refreshUsage: boolean): void {
  if (record.kind !== 'event') {
    return;
  }
  applyAgentEvent(state, {
    source: record.source,
    event: record.event,
    sessionId: record.sessionId,
    project: record.project,
    now: record.recordedAt
  });
  expireStaleSessions(state, record.recordedAt, ttlMs(config));
  addOwedWork(state, record, { refreshUsage });
}

function recordFileExists(statePath: string, id: string): Promise<boolean> {
  return fileExists(join(queuePaths(statePath).queueDir, `${id}${RECORD_EXTENSION}`));
}

/**
 * One batch of the apply lane (Plan 0003 3.5), run by the worker lock's holder:
 * 1. list the queue; delete the files whose ids `queueApplied` holds, unapplied; read the rest in order, stopping at a
 *    record with a higher `v` than `version`. A bad record moves to `failed/`; a record whose epoch is not the current
 *    one was recorded around an uninstall and is deleted unapplied (3.8).
 * 2. under the state lock, apply the records in order with their recorded times, add their ids to `queueApplied` (and
 *    drop the ids whose files are gone) and the work they owe, and save once;
 * 3. delete the applied files.
 * A process killed anywhere in between leaves either the records or their ids in the state, never both applied and
 * pending, so the next batch applies each record once.
 */
export async function applyQueueBatch(statePath: string, options: ApplyBatchOptions): Promise<BatchOutcome> {
  const { records: files } = await listQueue(statePath);
  if (files.length === 0) {
    return NOTHING_LISTED;
  }
  const backlogWarning = options.backlogWarning ?? processBacklogWarning;
  // The batch's log lines go into one append, so a batch takes the log lock once (Plan 0003 3.11).
  const lines: string[] = [];
  if (backlogWarning.due(files.length)) {
    lines.push(infoLogLine({ type: 'queue.backlog', records: files.length }));
  }

  const applied = new Set((await loadState(statePath)).queueApplied);
  const epoch = await readEpoch(statePath);
  const pending: Array<{ file: QueueFile; record: QueueRecord }> = [];
  let newer = false;
  for (const file of files) {
    if (applied.has(file.id)) {
      await deleteQueueFile(file);
      continue;
    }
    const read = await readQueueFile(file, options.version);
    if (read.status === 'newer') {
      newer = true;
      break;
    }
    if (read.status === 'bad') {
      await moveToFailed(statePath, file, options.clock);
      lines.push(infoLogLine({ type: 'queue.record.failed', id: file.id, reason: read.reason }));
    } else if (read.status === 'record') {
      if (read.record.epoch === epoch) {
        pending.push({ file, record: read.record });
      } else {
        await deleteQueueFile(file);
        lines.push(infoLogLine({ type: 'queue.record.stale-epoch', id: file.id }));
      }
    }
  }
  await options.onStep?.('read');
  if (pending.length === 0) {
    if (lines.length > 0) {
      await logQuietly(() => appendLogLines(lines));
    }
    return { listed: files.length, applied: 0, appliedEvents: false, newer };
  }
  // Checked before taking the state lock, since a backlog makes this list long. An id may leave `queueApplied` only
  // once its file is gone, or the record would be applied again.
  const appliedWithFiles = new Set<string>();
  for (const id of applied) {
    if (await recordFileExists(statePath, id)) {
      appliedWithFiles.add(id);
    }
  }

  const refreshUsage = usageRenderPlan(options.config).enabled;
  let saved: typeof pending = [];
  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    // Only the worker lock's holder writes `queueApplied`, so none of these is in it; the check costs nothing.
    const already = new Set(state.queueApplied);
    saved = pending.filter(({ record }) => !already.has(record.id));
    for (const { record } of saved) {
      applyRecord(state, record, options.config, refreshUsage);
    }
    const kept: string[] = [];
    for (const id of state.queueApplied ?? []) {
      if (applied.has(id) ? appliedWithFiles.has(id) : await recordFileExists(statePath, id)) {
        kept.push(id);
      }
    }
    state.queueApplied = [...kept, ...saved.map(({ record }) => record.id)];
    await saveState(state, statePath);
  });
  await options.onStep?.('saved');

  for (const { file } of pending) {
    await deleteQueueFile(file);
  }
  await options.onStep?.('deleted');

  // One append for the whole batch: each line would otherwise take the log lock on its own.
  await logQuietly(() =>
    appendLogLines([
      ...lines,
      ...saved.flatMap(({ record }) => recordLogLines(record)),
      infoLogLine({ type: 'queue.batch', applied: saved.length, listed: files.length })
    ])
  );
  return {
    listed: files.length,
    applied: saved.length,
    appliedEvents: saved.some(({ record }) => record.kind === 'event'),
    newer
  };
}
