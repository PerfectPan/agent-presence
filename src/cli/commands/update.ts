import { configSlotId, debounceMs, getStatePath, loadConfig, providerId, renderTemplates, ttlMs } from '../../config.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsPublish } from '../../providers/types.js';
import { readCredential } from '../../secret.js';
import { hasFlag, optionValue } from '../args.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';
import { syncExplicitSlotValueWithStateLock } from '../slot-sync.js';
import { refreshSignatureUsageBadges, usageRenderPlan } from '../usage-badge.js';

export async function update(args: string[]): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = createProvider(activeProvider, { config, credential });
  assertSupportsPublish(provider);
  const statePath = getStatePath();
  const force = hasFlag(args, '--force');
  const silent = hasFlag(args, '--silent');
  const now = Date.now();
  const explicitValue = optionValue(args, '--value');

  if (explicitValue !== undefined) {
    const result = await syncExplicitSlotValueWithStateLock(
      statePath,
      {
        force,
        now,
        debounceMs: debounceMs(config),
        value: explicitValue.slice(0, 200)
      },
      (value) => provider.publishValue(value)
    );
    if (!silent) {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  // An explicit update is infrequent, so refresh usage badges here too (when
  // enabled) before rendering, mirroring the hook path's boundary refresh.
  const usagePlan = usageRenderPlan(config);
  if (usagePlan.enabled) {
    await refreshSignatureUsageBadges(config, statePath, now);
  }

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
