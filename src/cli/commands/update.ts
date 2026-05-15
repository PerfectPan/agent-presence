import { configSlotId, debounceMs, getStatePath, loadConfig, providerBaseUrl, providerId, renderTemplates, ttlMs } from '../../config.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsSlotUpdate } from '../../providers/types.js';
import { readCredential } from '../../secret.js';
import { hasFlag, optionValue } from '../args.js';
import { syncExplicitSlotValueWithStateLock, syncRenderedSlotWithStateLock } from '../slot-sync.js';

export async function update(args: string[]): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = createProvider(activeProvider, { baseUrl: providerBaseUrl(config), credential });
  assertSupportsSlotUpdate(provider);
  const statePath = getStatePath();
  const force = hasFlag(args, '--force');
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
      (value) => provider.updateSlot(value)
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = await syncRenderedSlotWithStateLock(
    statePath,
    {
      force,
      now,
      debounceMs: debounceMs(config),
      ttlMs: ttlMs(config),
      renderTemplates: renderTemplates(config)
    },
    (value) => provider.updateSlot(value)
  );
  console.log(JSON.stringify(result, null, 2));
}
