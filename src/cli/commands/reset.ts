import {
  configSlotId,
  debounceMs,
  getStatePath,
  loadConfig,
  providerId,
  renderTemplates,
  ttlMs
} from '../../config.js';
import { takeOver, type TakeoverOptions } from '../../queue/takeover.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsPublish } from '../../providers/types.js';
import type { SyncSlotResult } from '../../render.js';
import { readCredential } from '../../secret.js';
import { finishAllSessions } from '../../state.js';
import { hasFlag, optionValue } from '../args.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';
import { disabledSlotResult } from '../slot-sync.js';
import { usageRenderPlan } from '../usage-badge.js';

export async function reset(args: string[], takeover: TakeoverOptions = {}): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = createProvider(activeProvider, { config, credential });
  assertSupportsPublish(provider);
  const statePath = getStatePath();
  const now = Date.now();
  const force = hasFlag(args, '--force');
  const silent = hasFlag(args, '--silent');
  const usagePlan = usageRenderPlan(config);

  const result = await takeOver(
    statePath,
    async (queue): Promise<SyncSlotResult> => {
      // The pending records were recorded before this run; reset applies them first, then finishes every session
      // (Plan 0003 3.7).
      await queue.applyPending();
      if (queue.disabled) {
        return disabledSlotResult(statePath);
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
        (value) => provider.publishValue(value),
        (state) => {
          finishAllSessions(state, now);
        }
      );
    },
    takeover
  );

  if (!silent) {
    console.log(JSON.stringify(result, null, 2));
  }
}
