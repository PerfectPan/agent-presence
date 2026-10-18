import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as z from 'zod/mini';
// Imported by name: called as `z.catch(...)`, the promise lint rule mistakes it for `Promise.prototype.catch`.
import { catch as catchInvalid } from 'zod/mini';
import { getStatePath } from './config.js';
import { readJsonFile, writeJsonAtomic } from './json-file.js';
import { acquireLock } from './process-lock.js';
import { parseQueueApplied, parseQueueOwed } from './queue/schema.js';
import { createEmptyState, type AgentSession, type PresenceState } from './state.js';

const STATE_LOCK_WAIT_MS = 2_000;
// From its 50 ms default the kit's backoff reaches 800 ms and times waiters out under contention; from 5 ms, 80 ms.
const STATE_LOCK_RETRY_MS = 5;

// The state file is untrusted disk JSON: it may be hand-edited, truncated, or written by another release. A field or
// map entry whose value does not parse loads as missing, never as a failed load, and top-level fields this release
// does not know are dropped when it saves. The queue fields are the exception: they keep what this release does not
// know inside them, because releases with the queue save the state in turns.
const entries = z.record(z.string(), z.unknown());
const windowKey = z.string().check(z.regex(/^\d+$/));
const nonEmptyKey = z.string().check(z.minLength(1));
const timestamp = z.number().check(z.positive());

const sessionSchema = z.object({
  id: nonEmptyKey,
  source: catchInvalid(z.optional(z.string()), undefined),
  // Sessions written before `source` existed named their agent in `kind`.
  kind: catchInvalid(z.optional(z.string()), undefined),
  status: z.enum(['running', 'finished', 'expired']),
  startedAt: timestamp,
  lastHeartbeatAt: timestamp,
  finishedAt: catchInvalid(z.optional(z.number()), undefined),
  project: catchInvalid(z.optional(z.string()), undefined)
});

const snapshotSchema = z.object({
  totalTokens: z.number().check(z.nonnegative()),
  costUsd: z.nullable(z.number().check(z.nonnegative())),
  scannedAt: z.number()
});

const stateSchema = z.object({
  sessions: catchInvalid(z.optional(entries), undefined),
  lastSlotUpdateAt: catchInvalid(z.optional(z.number()), undefined),
  lastValue: catchInvalid(z.optional(z.string()), undefined),
  pendingSlotFlushAt: catchInvalid(z.optional(z.number()), undefined),
  usageBadges: catchInvalid(z.optional(entries), undefined),
  usageBadgesAt: catchInvalid(z.optional(z.number()), undefined),
  usageSnapshots: catchInvalid(z.optional(entries), undefined),
  queueApplied: z.optional(z.unknown()),
  queueOwed: z.optional(z.unknown())
});

/** The entries whose key and value both parse, so a malformed entry drops only itself. */
function validEntries<V>(
  raw: Record<string, unknown> | undefined,
  key: z.ZodMiniType<string>,
  value: z.ZodMiniType<V>
): Record<string, V> {
  const valid: Record<string, V> = {};
  for (const [name, entry] of Object.entries(raw ?? {})) {
    const parsed = value.safeParse(entry);
    if (parsed.success && key.safeParse(name).success) {
      valid[name] = parsed.data;
    }
  }
  return valid;
}

function nonEmpty<V>(record: Record<string, V>): Record<string, V> | undefined {
  return Object.keys(record).length > 0 ? record : undefined;
}

export function normalizeState(raw: unknown): PresenceState {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) {
    return createEmptyState();
  }
  const state = parsed.data;

  const sessions: Record<string, AgentSession> = {};
  for (const [key, session] of Object.entries(validEntries(state.sessions, z.string(), sessionSchema))) {
    const source = session.source ?? (session.kind && session.kind !== 'coding' ? session.kind : undefined);
    if (!source) {
      continue;
    }
    sessions[key] = {
      id: session.id,
      source,
      kind: 'coding',
      status: session.status,
      startedAt: session.startedAt,
      lastHeartbeatAt: session.lastHeartbeatAt,
      finishedAt: session.status === 'running' ? undefined : session.finishedAt,
      project: session.project
    };
  }

  const usageSnapshots: NonNullable<PresenceState['usageSnapshots']> = {};
  for (const [days, sources] of Object.entries(validEntries(state.usageSnapshots, windowKey, entries))) {
    const snapshots = nonEmpty(validEntries(sources, nonEmptyKey, snapshotSchema));
    if (snapshots) {
      usageSnapshots[days] = snapshots;
    }
  }

  return {
    sessions,
    lastSlotUpdateAt: state.lastSlotUpdateAt ?? 0,
    lastValue: state.lastValue ?? '',
    pendingSlotFlushAt: state.pendingSlotFlushAt,
    usageBadges: nonEmpty(validEntries(state.usageBadges, windowKey, z.string())),
    usageBadgesAt: state.usageBadgesAt,
    usageSnapshots: nonEmpty(usageSnapshots),
    queueApplied: parseQueueApplied(state.queueApplied),
    queueOwed: parseQueueOwed(state.queueOwed)
  };
}

export async function loadState(statePath = getStatePath()): Promise<PresenceState> {
  return normalizeState(await readJsonFile<unknown>(statePath, createEmptyState()));
}

export async function saveState(state: PresenceState, statePath = getStatePath()): Promise<void> {
  await writeJsonAtomic(statePath, state);
}

/**
 * Run `fn` while holding the state lock of `statePath`, waiting up to `waitMs` (2 seconds by default) for another
 * holder. The lock is the kit's process lock, so a holder that crashes releases it at once.
 */
export async function withStateLock<T>(
  statePath: string,
  fn: () => Promise<T>,
  options: { waitMs?: number } = {}
): Promise<T> {
  // Every release that writes this state file must lock this same path. It is not the previous `<state>.lock`
  // directory: releases that used it delete that path on release and on reclaim.
  const lockPath = `${statePath}.lock.db`;
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const signal = AbortSignal.timeout(options.waitMs ?? STATE_LOCK_WAIT_MS);

  let lock;
  try {
    lock = await acquireLock(lockPath, signal, { retryMs: STATE_LOCK_RETRY_MS });
  } catch (error) {
    throw signal.aborted ? new Error(`timed out waiting for state lock: ${lockPath}`) : error;
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
