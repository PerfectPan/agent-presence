import { isDeepStrictEqual } from 'node:util';
import { isSessionBoundaryEvent, type PresenceState } from '../state.js';
// Type-only, so erased: this module loads no schema.
import type { DshUsageEntry, EventRecord, QueueOwed, ScanEnv, UsageRefreshEntry } from './schema.js';

// The follow-up work that applied records owe, kept in the state's `queueOwed` (Plan 0003 3.5). Releases with the
// queue save the state in turns, so every change here is made in place on the parsed entries: an entry keeps the
// fields this release does not know, and keys and kinds it does not know are never touched.

/** The kinds of owed work this release knows and works off. */
export type OwedKind = 'dshUsage' | 'usageRefresh' | 'renderedSync';

export const ALL_OWED_KINDS: readonly OwedKind[] = ['dshUsage', 'usageRefresh', 'renderedSync'];

/** One owed item this release can do. */
export type OwedItem =
  | { readonly kind: 'dshUsage'; readonly entry: DshUsageEntry }
  | { readonly kind: 'usageRefresh'; readonly entry: UsageRefreshEntry }
  | { readonly kind: 'renderedSync' };

/**
 * Whether a refresh entry is the one for `source` and `scanEnv`: the same source and the same whole `scanEnv`, keys
 * this release does not know included, in any key order. So an older release never merges two entries that a newer
 * release keeps apart.
 */
export function isRefreshFor(entry: UsageRefreshEntry, source: string, scanEnv: ScanEnv): boolean {
  return entry.source === source && isDeepStrictEqual(entry.scanEnv, scanEnv);
}

function owedOf(state: PresenceState): QueueOwed {
  state.queueOwed ??= {};
  return state.queueOwed;
}

/**
 * Add what an applied event record owes: a dsh usage append when it carries usage, a refresh of its source and
 * `scanEnv` at a session boundary when `refreshUsage` is set (the signature renders usage), and the rendered sync. A
 * boundary for a source and `scanEnv` already owed updates that entry: its boundary time moves to the later one and its
 * generation increases, so a refresh already running for it keeps it owed (Plan 0003 3.5).
 */
export function addOwedWork(state: PresenceState, record: EventRecord, options: { refreshUsage: boolean }): void {
  const owed = owedOf(state);
  if (record.usage) {
    owed.dshUsage ??= [];
    owed.dshUsage.push({ id: record.id, usage: record.usage });
  }
  if (options.refreshUsage && isSessionBoundaryEvent(record.event)) {
    const scanEnv = record.scanEnv ?? {};
    owed.usageRefresh ??= [];
    const entry = owed.usageRefresh.find((candidate) => isRefreshFor(candidate, record.source, scanEnv));
    if (entry) {
      entry.boundaryAt = Math.max(entry.boundaryAt, record.recordedAt);
      entry.generation += 1;
    } else {
      owed.usageRefresh.push({ source: record.source, scanEnv, boundaryAt: record.recordedAt, generation: 1 });
    }
  }
  owed.renderedSync = true;
}

/** Remove the owed dsh usage append of record `id`, once its line is written. */
export function removeDshUsage(state: PresenceState, id: string): void {
  const entries = state.queueOwed?.dshUsage;
  if (!entries) {
    return;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.id === id) {
      entries.splice(index, 1);
    }
  }
}

/**
 * Remove the owed refresh that `done` describes, unless a boundary updated it since: only an entry for the same source
 * and `scanEnv` that still has `done`'s generation goes.
 */
export function removeRefreshUnlessUpdated(state: PresenceState, done: UsageRefreshEntry): void {
  const entries = state.queueOwed?.usageRefresh;
  const index =
    entries?.findIndex(
      (entry) => isRefreshFor(entry, done.source, done.scanEnv) && entry.generation === done.generation
    ) ?? -1;
  if (index >= 0) {
    entries?.splice(index, 1);
  }
}

/** Mark the rendered value as owed a sync, as an applied event or a completed usage refresh does. */
export function oweRenderedSync(state: PresenceState): void {
  owedOf(state).renderedSync = true;
}

/** Clear the owed rendered sync: a sync published the value the state renders, scheduled that publish, or found nothing to publish. */
export function settleRenderedSync(state: PresenceState): void {
  if (state.queueOwed?.renderedSync !== undefined) {
    delete state.queueOwed.renderedSync;
  }
}

/**
 * The owed items this release can do, in the order they are worked off: the dsh usage appends, the refreshes of
 * sources in `sources` (the merged source table), then the rendered sync. A refresh for a source the table does not
 * have, and every key this release does not know, stay owed untouched and are not listed.
 */
export function doableOwedItems(owed: QueueOwed | undefined, sources: ReadonlySet<string>): OwedItem[] {
  if (!owed) {
    return [];
  }
  const items: OwedItem[] = [];
  for (const entry of owed.dshUsage ?? []) {
    items.push({ kind: 'dshUsage', entry });
  }
  for (const entry of owed.usageRefresh ?? []) {
    if (sources.has(entry.source)) {
      items.push({ kind: 'usageRefresh', entry });
    }
  }
  if (owed.renderedSync === true) {
    items.push({ kind: 'renderedSync' });
  }
  return items;
}
