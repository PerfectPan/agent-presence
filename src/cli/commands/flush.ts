import { configSlotId, debounceMs, getStatePath, loadConfig, providerId, renderTemplates, ttlMs } from '../../config.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsPublish } from '../../providers/types.js';
import { readCredential } from '../../secret.js';
import { hasFlag, optionValue } from '../args.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';
import { usageRenderPlan } from '../usage-badge.js';

/** Publish the latest cached presence state without collecting usage. */
export async function flush(args: string[]): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = createProvider(activeProvider, { config, credential });
  assertSupportsPublish(provider);
  const statePath = getStatePath();
  const force = hasFlag(args, '--force');
  const silent = hasFlag(args, '--silent');
  const now = Date.now();
  const usagePlan = usageRenderPlan(config);

  const result = await syncRenderedSlotWithDeferredFlush(
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

  if (!silent) {
    console.log(JSON.stringify(result, null, 2));
  }
}
