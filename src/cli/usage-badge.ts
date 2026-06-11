import {
  usagePricingOverrides,
  usageSignatureWindowDays,
  type AppConfig
} from '../config.js';
import { renderUsageBadge } from '../usage/format.js';
import { collectWindowUsage } from '../usage/index.js';
import { loadState, saveState, withStateLock } from '../state.js';

/**
 * Rescan transcripts and refresh the cached usage badge in state. Called only on
 * session-boundary events (start/finish): the scan reads the whole rolling
 * window, so any single refresh yields the complete, correct total — there is no
 * need to rescan on every hook. The scan runs outside the state lock and any
 * failure leaves the previous cached badge untouched, so a hook is never broken.
 */
export async function refreshSignatureUsageBadge(
  config: AppConfig,
  statePath: string,
  now: number
): Promise<void> {
  let badge: string;
  try {
    const window = await collectWindowUsage({
      days: usageSignatureWindowDays(config),
      now,
      pricing: usagePricingOverrides(config)
    });
    badge = renderUsageBadge(window.total.totalTokens, window.total.costUsd);
  } catch {
    return; // keep the previously cached badge on scan failure
  }

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    state.usageBadge = badge;
    state.usageBadgeAt = now;
    await saveState(state, statePath);
  });
}
