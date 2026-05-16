import { configSlotId, debounceMs, getStatePath, loadConfig, providerBaseUrl, providerId, renderTemplates, ttlMs } from '../../config.js';
import { LGaryYangProvider } from '../../providers/l-garyyang.js';
import { readCredential } from '../../secret.js';
import { hasFlag, optionValue } from '../args.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';
import { syncExplicitSlotValueWithStateLock } from '../slot-sync.js';

export async function update(args: string[]): Promise<void> {
  const config = await loadConfig();
  providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = new LGaryYangProvider(providerBaseUrl(config), credential);
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
      (value) => provider.updateSlot(value)
    );
    if (!silent) {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  const result = await syncRenderedSlotWithDeferredFlush(
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
  if (!silent) {
    console.log(JSON.stringify(result, null, 2));
  }
}
