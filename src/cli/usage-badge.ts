import {
  renderTemplates,
  usagePricingOverrides,
  usageShowInSignature,
  usageSignatureWindowDays,
  type AppConfig
} from '../config.js';
import { referencedUsageWindows } from '../render.js';
import { billableSources } from '../sources.js';
import { calendarDaysBetween } from '../time.js';
import { renderUsageBadge } from '../usage/format.js';
import { collectWindowUsage } from '../usage/index.js';
import type { BillableSource, PricingOverrides } from '../usage/index.js';
import { loadState, saveState, withStateLock, type UsageSnapshot } from '../state.js';

export interface UsageRenderPlan {
  /** Whether any usage badge should be rendered into the signature. */
  enabled: boolean;
  /** Rolling-window day counts that must be scanned. */
  windows: number[];
  /** Window exposed as the bare `{usage}` token and the auto-append. */
  defaultWindow: number;
}

/**
 * Decide which usage windows the signature needs. Usage is active when either
 * `usage.showInSignature` is set (zero-config auto-append of the default
 * window) or a render template references a `{usage}` / `{usage_Nd}` token.
 */
export function usageRenderPlan(config: AppConfig): UsageRenderPlan {
  const defaultWindow = usageSignatureWindowDays(config);
  const windows = new Set(referencedUsageWindows(renderTemplates(config), defaultWindow));
  if (usageShowInSignature(config)) {
    windows.add(defaultWindow);
  }
  return { enabled: windows.size > 0, windows: [...windows], defaultWindow };
}

/**
 * Refresh cached usage for every window the signature references. A hook passes
 * its source id and normally scans only that source; the first boundary after
 * midnight and an explicit update rebuild every built-in contribution. Scans
 * run outside the state lock and any failure leaves the previous cache intact.
 */
export async function refreshSignatureUsageBadges(
  config: AppConfig,
  statePath: string,
  now: number,
  source?: string
): Promise<void> {
  const plan = usageRenderPlan(config);
  if (!plan.enabled) {
    return;
  }

  const pricing = usagePricingOverrides(config);
  // The signature path stays first-party even for explicit updates: never load
  // third-party JS handlers here (`includeHandlers: false` keeps
  // `billableSources` from `import()`ing them on the hot path).
  const sources = await billableSources(config, { includeHandlers: false });
  await refreshUsageBadgeCache({
    statePath,
    now,
    windows: plan.windows,
    pricing,
    sources,
    source
  });
}

export interface UsageBadgeCacheRefresh {
  statePath: string;
  now: number;
  windows: number[];
  sources: BillableSource[];
  pricing?: PricingOverrides;
  /** A hook refresh owns only this source. Omit for an explicit full refresh. */
  source?: string;
}

/**
 * Refresh source-owned usage snapshots, then rebuild each aggregate badge from
 * the cached contributions. A hook normally supplies its source id, but the
 * first source boundary after midnight promotes that refresh to all built-ins
 * so inactive sources cannot leave the new calendar day permanently stale.
 * Explicit updates also replace the complete built-in snapshot set.
 */
export async function refreshUsageBadgeCache(options: UsageBadgeCacheRefresh): Promise<void> {
  const cachedState = await loadState(options.statePath);
  const refreshSource =
    options.source &&
    (cachedState.usageBadgesAt === undefined ||
      calendarDaysBetween(cachedState.usageBadgesAt, options.now) > 0)
      ? undefined
      : options.source;
  const selectedSources = refreshSource
    ? options.sources.filter((candidate) => candidate.id === refreshSource)
    : options.sources;
  if (refreshSource && selectedSources.length === 0) {
    return;
  }

  let results: Array<readonly [string, Record<string, UsageSnapshot>]>;
  try {
    results = await Promise.all(
      options.windows.map(async (days) => {
        const window = await collectWindowUsage({
          days,
          now: options.now,
          pricing: options.pricing,
          sources: selectedSources,
          failOnSourceError: true
        });
        return [
          String(days),
          Object.fromEntries(
            window.bySource.map((usage) => [
              usage.source,
              { totalTokens: usage.totalTokens, costUsd: usage.costUsd, scannedAt: options.now }
            ])
          )
        ] as const;
      })
    );
  } catch {
    return; // keep the previously cached badges on scan failure
  }

  await withStateLock(options.statePath, async () => {
    const state = await loadState(options.statePath);
    const snapshots = { ...state.usageSnapshots };
    const badges = { ...state.usageBadges };
    let rebuiltWindows = 0;

    for (const [days, refreshed] of results) {
      const previousSnapshots = Object.fromEntries(
        options.sources.flatMap((source) => {
          const snapshot = snapshots[days]?.[source.id];
          return snapshot ? [[source.id, snapshot] as const] : [];
        })
      );
      const bySource = Object.fromEntries(
        options.sources.flatMap((source) => {
          const previous = previousSnapshots[source.id];
          const candidate = refreshed[source.id];
          if (!candidate) {
            return previous ? [[source.id, previous] as const] : [];
          }
          // Scans happen outside the lock. Preserve a snapshot committed by a
          // newer overlapping refresh instead of letting an older scan win by
          // finishing last.
          const latest =
            previous && previous.scannedAt > candidate.scannedAt ? previous : candidate;
          return [[source.id, latest] as const];
        })
      );
      snapshots[days] = bySource;

      // A partial cache cannot produce a truthful aggregate. Cross-midnight
      // refreshes are promoted to a full scan above, so every configured
      // built-in receives a current-day contribution, including zero usage.
      if (
        options.sources.every((source) => {
          const snapshot = bySource[source.id];
          return snapshot !== undefined && calendarDaysBetween(snapshot.scannedAt, options.now) === 0;
        })
      ) {
        const aggregate = aggregateSnapshots(Object.values(bySource));
        badges[days] = renderUsageBadge(aggregate.totalTokens, aggregate.costUsd);
        rebuiltWindows += 1;
      }
    }

    state.usageSnapshots = snapshots;
    state.usageBadges = badges;
    if (results.length > 0 && rebuiltWindows === results.length) {
      state.usageBadgesAt = Math.max(state.usageBadgesAt ?? options.now, options.now);
    }
    await saveState(state, options.statePath);
  });
}

function aggregateSnapshots(snapshots: UsageSnapshot[]): { totalTokens: number; costUsd: number | null } {
  let totalTokens = 0;
  let costUsd = 0;
  let sawCost = false;
  for (const snapshot of snapshots) {
    totalTokens += snapshot.totalTokens;
    if (snapshot.costUsd !== null) {
      sawCost = true;
      costUsd += snapshot.costUsd;
    }
  }
  return { totalTokens, costUsd: sawCost ? costUsd : null };
}
