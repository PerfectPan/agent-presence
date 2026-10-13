import {
  configSlotId,
  debounceMs,
  getStatePath,
  providerId,
  renderTemplates,
  ttlMs,
  type AppConfig
} from '../config.js';
import { createProvider } from '../providers/registry.js';
import { assertSupportsPublish } from '../providers/types.js';
import { readCredential } from '../secret.js';
import { applyAgentEvent, isSessionBoundaryEvent } from '../state.js';
import { appendUsageEvent, usageEventFromPayload } from '../usage-events.js';
import { syncRenderedSlotWithDeferredFlush } from './rendered-slot-sync.js';
import { refreshSignatureUsageBadges, usageRenderPlan } from './usage-badge.js';

export interface ResolvedHookEvent {
  config: AppConfig;
  source: string;
  event: string;
  sessionId: string;
  project?: string;
  payload: unknown;
}

/**
 * Apply a resolved hook event in the hook process: append its dsh usage, refresh the usage badges at a session
 * boundary, then update the state and sync the rendered slot. The hook command loads this module with a dynamic
 * `import()` so its static graph reaches no state store or usage scanner (test/hook-graph.test.ts).
 */
export async function applyHookEvent(hookEvent: ResolvedHookEvent): Promise<void> {
  const { config, source, event, sessionId, project, payload } = hookEvent;
  const statePath = getStatePath();
  const now = Date.now();

  // Ingest real-time usage reported by a source plugin (dsh) before the
  // boundary refresh below, so a Stop carrying usage is counted in the same
  // boundary's scan. Best-effort: a failed append must never break the hook.
  const usageEvent = usageEventFromPayload(source, payload, now);
  if (usageEvent) {
    await appendUsageEvent(usageEvent).catch(() => {});
  }

  // Refresh cached usage badges only at session boundaries. Same-day events
  // scan their owning source; the first boundary after midnight scans all
  // built-ins once so inactive sources cannot block the new day's aggregate.
  const usagePlan = usageRenderPlan(config);
  if (usagePlan.enabled && isSessionBoundaryEvent(event)) {
    await refreshSignatureUsageBadges(config, statePath, now, source);
  }

  await syncRenderedSlotWithDeferredFlush(
    statePath,
    {
      force: false,
      now,
      debounceMs: debounceMs(config),
      ttlMs: ttlMs(config),
      renderTemplates: renderTemplates(config),
      usage: { enabled: usagePlan.enabled, defaultWindow: usagePlan.defaultWindow }
    },
    async (value) => {
      // Keep Keychain/provider IO after the local state mutation has been persisted.
      const credential = await readCredential(configSlotId(config));
      const provider = createProvider(providerId(config), { config, credential });
      assertSupportsPublish(provider);
      await provider.publishValue(value);
    },
    (state) => {
      applyAgentEvent(state, { source, event, sessionId, project, now });
    }
  );
}
