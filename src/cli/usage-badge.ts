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
 * its source id and scans only that source; an explicit update omits the source
 * and rebuilds every built-in contribution. Scans run outside the state lock
 * and any failure leaves the previous cache intact.
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
 * the cached contributions. A hook supplies its source id; explicit updates
 * omit it and replace the complete built-in snapshot set.
 */
export async function refreshUsageBadgeCache(options: UsageBadgeCacheRefresh): Promise<void> {
  const selectedSources = options.source
    ? options.sources.filter((candidate) => candidate.id === options.source)
    : options.sources;
  if (options.source && selectedSources.length === 0) {
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
          sources: selectedSources
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
      const activeSnapshots = Object.fromEntries(
        options.sources.flatMap((source) => {
          const snapshot = snapshots[days]?.[source.id];
          return snapshot ? [[source.id, snapshot] as const] : [];
        })
      );
      const bySource = options.source ? { ...activeSnapshots, ...refreshed } : refreshed;
      snapshots[days] = bySource;

      // A partial or cross-midnight cache cannot produce a truthful aggregate:
      // calendar-day windows shift at midnight, so yesterday's source snapshot
      // is incompatible with a source refreshed today. Keep the previous badge
      // until every configured built-in has a current-day contribution.
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
      state.usageBadgesAt = options.now;
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
