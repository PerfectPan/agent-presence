import { configSlotId, debounceMs, getStatePath, providerId, renderTemplates, ttlMs } from '../../config.js';
import { loadValidatedConfig } from '../../config-schema.js';
import { settleRenderedSync } from '../../queue/owed.js';
import { takeOver, type TakeoverOptions } from '../../queue/takeover.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsPublish } from '../../providers/types.js';
import type { SyncSlotResult } from '../../render.js';
import { readCredential } from '../../secret.js';
import { hasFlag, optionValue } from '../args.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';
import { disabledSlotResult, syncExplicitSlotValueWithStateLock } from '../slot-sync.js';
import { refreshSignatureUsageBadges, usageRenderPlan } from '../usage-badge.js';

export async function update(args: string[], takeover: TakeoverOptions = {}): Promise<void> {
  const { config } = await loadValidatedConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = createProvider(activeProvider, { config, credential });
  assertSupportsPublish(provider);
  const statePath = getStatePath();
  const force = hasFlag(args, '--force');
  const silent = hasFlag(args, '--silent');
  const explicitValue = optionValue(args, '--value');

  if (explicitValue !== undefined) {
    const result = await takeOver(
      statePath,
      async (queue): Promise<SyncSlotResult> => {
        // The pending records were recorded before this run; they apply first.
        await queue.applyPending();
        await queue.workOffOwed(['dshUsage']);
        if (queue.disabled) {
          return disabledSlotResult(statePath);
        }
        // Read after the apply: an applied record can be newer than the command's start, and `now` must not be earlier
        // than an applied record's time.
        const now = Date.now();
        return syncExplicitSlotValueWithStateLock(
          statePath,
          {
            force,
            now,
            debounceMs: debounceMs(config),
            value: explicitValue.slice(0, 200)
          },
          (value) => provider.publishValue(value),
          // The explicit value is the one the slot keeps: settle the owed rendered sync in the save that records it,
          // so a later worker does not overwrite it with the rendered one.
          settleRenderedSync
        );
      },
      takeover
    );
    if (!silent) {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  const result = await takeOver(
    statePath,
    async (queue): Promise<SyncSlotResult> => {
      // The pending records were recorded before this run; they apply first.
      await queue.applyPending();
      await queue.workOffOwed(['dshUsage']);
      if (queue.disabled) {
        return disabledSlotResult(statePath);
      }
      // Read after the apply, for the same reason as the explicit branch above.
      const now = Date.now();
      // An explicit update is infrequent, so establish a complete usage snapshot
      // before rendering. Hook boundaries are source-scoped after the day's first
      // boundary has established a complete built-in snapshot.
      const usagePlan = usageRenderPlan(config);
      if (usagePlan.enabled) {
        await refreshSignatureUsageBadges(config, statePath, now);
      }
      return syncRenderedSlotWithDeferredFlush(
        statePath,
        {
          force,
          now,
          debounceMs: debounceMs(config),
          ttlMs: ttlMs(config),
          renderTemplates: renderTemplates(config),
          usage: { enabled: usagePlan.enabled, defaultWindow: usagePlan.defaultWindow }
        },
        (value) => provider.publishValue(value)
      );
    },
    takeover
  );
  if (!silent) {
    console.log(JSON.stringify(result, null, 2));
  }
}
