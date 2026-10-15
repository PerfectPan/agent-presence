import { configSlotId, debounceMs, getStatePath, providerId, renderTemplates, ttlMs } from '../../config.js';
import { loadValidatedConfig } from '../../config-schema.js';
import { takeOver, type TakeoverOptions } from '../../queue/takeover.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsPublish } from '../../providers/types.js';
import type { SyncSlotResult } from '../../render.js';
import { readCredential } from '../../secret.js';
import { hasFlag, optionValue } from '../args.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';
import { disabledSlotResult } from '../slot-sync.js';
import { usageRenderPlan } from '../usage-badge.js';

/** Publish the latest cached presence state without collecting usage. */
export async function flush(args: string[], takeover: TakeoverOptions = {}): Promise<void> {
  const { config } = await loadValidatedConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = createProvider(activeProvider, { config, credential });
  assertSupportsPublish(provider);
  const statePath = getStatePath();
  const force = hasFlag(args, '--force');
  const silent = hasFlag(args, '--silent');
  const usagePlan = usageRenderPlan(config);

  const result = await takeOver(
    statePath,
    async (queue): Promise<SyncSlotResult> => {
      // The pending records were recorded before this run; they apply first (Plan 0003 3.7).
      await queue.applyPending();
      await queue.workOffOwed(['dshUsage']);
      if (queue.disabled) {
        return disabledSlotResult(statePath);
      }
      // Read after the apply: an applied record can be newer than the command's start, and `now` must not be earlier
      // than an applied record's time (Plan 0003 3.7).
      const now = Date.now();
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
