import { configSlotId, debounceMs, providerId, renderTemplates, ttlMs, type AppConfig } from '../config.js';
import { BUILTIN_SOURCE_PLUGINS, SCAN_ENV } from '../cli/hook-context.js';
import { syncRenderedSlotWithDeferredFlush } from '../cli/rendered-slot-sync.js';
import { refreshSignatureUsageBadges, usageRenderPlan, type UsageRefreshOutcome } from '../cli/usage-badge.js';
import { createProvider } from '../providers/registry.js';
import { assertSupportsPublish } from '../providers/types.js';
import { readCredential } from '../secret.js';
import { mergedSources } from '../sources.js';
import type { PresenceState } from '../state.js';
import { loadState, saveState, withStateLock } from '../state-store.js';
import { appendUsageEvent } from '../usage-events-log.js';
import type { ScanEnvironment } from '../usage/types.js';
import type { QueueClock } from './files.js';
import {
  doableOwedItems,
  isRefreshFor,
  oweRenderedSync,
  removeDshUsage,
  removeRefreshUnlessUpdated,
  type OwedItem,
  type OwedKind
} from './owed.js';
import type { RecordUsage, UsageRefreshEntry } from './schema.js';

/** What a usage refresh of one owed entry gets. */
export interface UsageRefreshRequest {
  readonly config: AppConfig;
  readonly statePath: string;
  readonly source: string;
  /** The latest boundary's recorded time, the refresh's `now`, so the first-boundary-of-a-day rule holds. */
  readonly boundaryAt: number;
  /** The environment the scanners read transcript roots from: the worker's, with the values the boundary recorded. */
  readonly env: ScanEnvironment;
  readonly signal: AbortSignal;
  /** Runs inside the refresh's locked save. */
  readonly onSave: (state: PresenceState) => void;
}

/** The side effects of owed work; tests replace them. */
export interface OwedWorkEffects {
  /** Append a dsh usage line carrying the record id; resolves whether it was written before `signal` aborted. */
  appendUsage(usage: RecordUsage, id: string, signal: AbortSignal): Promise<boolean>;
  refreshUsage(request: UsageRefreshRequest): Promise<UsageRefreshOutcome>;
  /** Publish a rendered value with the configured provider and credential. */
  publish(value: string, config: AppConfig, signal: AbortSignal): Promise<void>;
}

export const defaultOwedWorkEffects: OwedWorkEffects = {
  appendUsage: (usage, id, signal) => appendUsageEvent(usage, { id, signal }),
  refreshUsage: (request) =>
    refreshSignatureUsageBadges(request.config, request.statePath, request.boundaryAt, request.source, {
      signal: request.signal,
      env: request.env,
      onSave: request.onSave
    }),
  publish: async (value, config, signal) => {
    // Credentials come from the worker's environment, which is that of the hook or command that started it (3.9).
    const credential = await readCredential(configSlotId(config));
    const provider = createProvider(providerId(config), { config, credential });
    assertSupportsPublish(provider);
    await provider.publishValue(value, { signal });
  }
};

/** The ids of the sources in the merged source table: the refreshes this release can do. */
export function knownSources(config: AppConfig): ReadonlySet<string> {
  return new Set(Object.keys(mergedSources(config)));
}

/**
 * The environment a refresh of `entry` scans with: the worker's own, with every transcript-root variable that the
 * entry's built-in source reads, or that the entry recorded, set to the recorded value or unset when it recorded none.
 */
export function scanEnvironmentFor(entry: UsageRefreshEntry): ScanEnvironment {
  const env: Record<string, string | undefined> = { ...process.env };
  const sourceNames = BUILTIN_SOURCE_PLUGINS[entry.source]?.scanEnv ?? [];
  for (const name of Object.values(SCAN_ENV)) {
    if (sourceNames.includes(name) || Object.hasOwn(entry.scanEnv, name)) {
      env[name] = entry.scanEnv[name];
    }
  }
  return env;
}

export type OwedOutcome = 'done' | 'aborted' | 'failed';

export interface OwedWorkContext {
  readonly statePath: string;
  readonly config: AppConfig;
  /** The rendered sync's `now`. */
  readonly clock: QueueClock;
  readonly effects: OwedWorkEffects;
  /** Aborts the item: the dsh append's wait for the log lock, the refresh's scans, the publish's request. */
  readonly signal: AbortSignal;
}

async function updateState(statePath: string, change: (state: PresenceState) => void): Promise<void> {
  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    change(state);
    await saveState(state, statePath);
  });
}

async function appendOwedUsage(
  item: Extract<OwedItem, { kind: 'dshUsage' }>,
  context: OwedWorkContext
): Promise<OwedOutcome> {
  const { entry } = item;
  // The entry's usage is written as parsed, fields this release does not know included (3.5).
  if (!(await context.effects.appendUsage(entry.usage, entry.id, context.signal))) {
    return 'aborted';
  }
  // A process killed before this save appends the line again; the reader skips the repeated id.
  await updateState(context.statePath, (state) => removeDshUsage(state, entry.id));
  return 'done';
}

async function refreshOwedUsage(
  item: Extract<OwedItem, { kind: 'usageRefresh' }>,
  context: OwedWorkContext
): Promise<OwedOutcome> {
  const { entry } = item;
  // The parsed entry is a snapshot from before the refresh; its generation tells a later boundary apart.
  const done = { ...entry };
  const refresh = { saved: false };
  const outcome = await context.effects.refreshUsage({
    config: context.config,
    statePath: context.statePath,
    source: entry.source,
    boundaryAt: entry.boundaryAt,
    env: scanEnvironmentFor(entry),
    signal: context.signal,
    onSave: (state) => {
      refresh.saved = true;
      removeRefreshUnlessUpdated(state, done);
      // The refreshed usage changes what the slot renders.
      oweRenderedSync(state);
    }
  });
  if (!outcome.completed) {
    return 'aborted';
  }
  if (!refresh.saved) {
    // Completed without saving (nothing to scan, or a failed scan kept the cache): nothing changed but the debt.
    await updateState(context.statePath, (state) => removeRefreshUnlessUpdated(state, done));
  }
  return 'done';
}

async function syncOwedRendered(context: OwedWorkContext): Promise<OwedOutcome> {
  const { config } = context;
  const usage = usageRenderPlan(config);
  // The sync settles `renderedSync` in its own locked saves and keeps it when the publish fails or aborts.
  await syncRenderedSlotWithDeferredFlush(
    context.statePath,
    {
      force: false,
      now: context.clock.now(),
      debounceMs: debounceMs(config),
      ttlMs: ttlMs(config),
      renderTemplates: renderTemplates(config),
      usage: { enabled: usage.enabled, defaultWindow: usage.defaultWindow }
    },
    (value) => context.effects.publish(value, config, context.signal)
  );
  return 'done';
}

/**
 * Work off one owed item (Plan 0003 3.5). `done` removed it from the state, in the same save as its effect where the
 * effect is a save; `aborted` and `failed` leave it owed.
 */
export async function workOffOwedItem(item: OwedItem, context: OwedWorkContext): Promise<OwedOutcome> {
  try {
    switch (item.kind) {
      case 'dshUsage':
        return await appendOwedUsage(item, context);
      case 'usageRefresh':
        return await refreshOwedUsage(item, context);
      case 'renderedSync':
        return await syncOwedRendered(context);
    }
  } catch {
    return context.signal.aborted ? 'aborted' : 'failed';
  }
}

/**
 * The owed items one applier already tried without getting them done. It does not try them again, so a provider that
 * keeps failing cannot keep it busy: a failed publish is tried again once an applied event or a refresh owes a new
 * sync, a refresh once a boundary updates its entry, and every item by the next applier.
 */
export interface OwedAttempts {
  /** The next item of `kinds` this applier can do and has not tried in vain, in work-off order. */
  next(state: PresenceState, sources: ReadonlySet<string>, kinds?: readonly OwedKind[]): OwedItem | undefined;
  /** Note an item that ended `aborted` or `failed`. */
  setAside(item: OwedItem): void;
  /** A new sync is owed: an applied event or a completed refresh. */
  renderedSyncOwedAgain(): void;
}

export function createOwedAttempts(): OwedAttempts {
  const dshIds = new Set<string>();
  const refreshes: UsageRefreshEntry[] = [];
  let renderedSync = false;
  const setAside = (item: OwedItem): boolean => {
    switch (item.kind) {
      case 'dshUsage':
        return dshIds.has(item.entry.id);
      case 'usageRefresh':
        return refreshes.some(
          (tried) =>
            isRefreshFor(tried, item.entry.source, item.entry.scanEnv) && tried.generation === item.entry.generation
        );
      case 'renderedSync':
        return renderedSync;
    }
  };
  return {
    next(state, sources, kinds) {
      return doableOwedItems(state.queueOwed, sources).find(
        (item) => (kinds === undefined || kinds.includes(item.kind)) && !setAside(item)
      );
    },
    setAside(item) {
      switch (item.kind) {
        case 'dshUsage':
          dshIds.add(item.entry.id);
          return;
        case 'usageRefresh':
          refreshes.push({ ...item.entry });
          return;
        case 'renderedSync':
          renderedSync = true;
          return;
      }
    },
    renderedSyncOwedAgain() {
      renderedSync = false;
    }
  };
}
