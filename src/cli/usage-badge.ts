import {
  renderTemplates,
  usagePricingOverrides,
  usageShowInSignature,
  usageSignatureWindowDays,
  type AppConfig
} from '../config.js';
import { referencedUsageWindows } from '../render.js';
import { billableSources } from '../sources.js';
import { renderUsageBadge } from '../usage/format.js';
import { collectWindowUsage } from '../usage/index.js';
import { loadState, saveState, withStateLock } from '../state.js';

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
 * Rescan transcripts and refresh the cached usage badges in state for every
 * window the signature references. Called only on session-boundary events (and
 * explicit updates): each scan reads the whole calendar-day window, so a single
 * refresh is complete — no per-event scanning, no cron. The scans run outside
 * the state lock and any failure leaves the previous cache intact.
 */
export async function refreshSignatureUsageBadges(
  config: AppConfig,
  statePath: string,
  now: number
): Promise<void> {
  const plan = usageRenderPlan(config);
  if (!plan.enabled) {
    return;
  }

  const pricing = usagePricingOverrides(config);
  // Runs on the hook path (session boundaries), so scan only the first-party
  // built-in sources — never load third-party JS handlers here (`includeHandlers:
  // false` keeps `billableSources` from `import()`ing them on the hot path).
  const sources = await billableSources(config, { includeHandlers: false });
  let badges: Record<string, string>;
  try {
    const results = await Promise.all(
      plan.windows.map(async (days) => {
        const window = await collectWindowUsage({ days, now, pricing, sources });
        return [String(days), renderUsageBadge(window.total.totalTokens, window.total.costUsd)] as const;
      })
    );
    badges = Object.fromEntries(results);
  } catch {
    return; // keep the previously cached badges on scan failure
  }

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    state.usageBadges = { ...state.usageBadges, ...badges };
    state.usageBadgesAt = now;
    await saveState(state, statePath);
  });
}
