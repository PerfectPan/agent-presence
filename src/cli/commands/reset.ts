import { configSlotId, debounceMs, getStatePath, loadConfig, providerBaseUrl, providerId, renderTemplates, ttlMs } from '../../config.js';
import { LGaryYangProvider } from '../../providers/l-garyyang.js';
import { readCredential } from '../../secret.js';
import { finishAllSessions } from '../../state.js';
import { hasFlag, optionValue } from '../args.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';

export async function reset(args: string[]): Promise<void> {
  const config = await loadConfig();
  providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = new LGaryYangProvider(providerBaseUrl(config), credential);
  const statePath = getStatePath();
  const now = Date.now();
  const force = hasFlag(args, '--force');
  const silent = hasFlag(args, '--silent');

  const result = await syncRenderedSlotWithDeferredFlush(
    statePath,
    {
      force,
      now,
      debounceMs: debounceMs(config),
      ttlMs: ttlMs(config),
      renderTemplates: renderTemplates(config)
    },
    (value) => provider.updateSlot(value),
    (state) => {
      finishAllSessions(state, now);
    }
  );

  if (!silent) {
    console.log(JSON.stringify(result, null, 2));
  }
}
