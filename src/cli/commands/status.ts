import { configSlotId, getStatePath, loadConfig, providerBaseUrl, providerId, renderTemplates, ttlMs } from '../../config.js';
import { LGaryYangProvider } from '../../providers/l-garyyang.js';
import { renderPresence } from '../../render.js';
import { readCredential } from '../../secret.js';
import { getActiveSessions, loadState, saveState, withStateLock } from '../../state.js';
import { hasFlag, optionValue } from '../args.js';

export async function printStatus(args: string[]): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const now = Date.now();
  const statePath = getStatePath();
  const credential = await readCredential(configSlotId(config));
  let payload: Record<string, unknown> | undefined;

  await withStateLock(statePath, async () => {
    const state = await loadState(statePath);
    const active = getActiveSessions(state, now, ttlMs(config));
    await saveState(state, statePath);
    payload = {
      activeCount: active.length,
      value: renderPresence(active, renderTemplates(config)),
      active,
      provider: activeProvider,
      lastValue: state.lastValue ?? '',
      lastSlotUpdateAt: state.lastSlotUpdateAt ?? 0,
      statePath,
      hasToken: Boolean(credential?.token),
      slotId: credential?.slotId ?? configSlotId(config) ?? ''
    };
  });

  if (hasFlag(args, '--remote') && credential) {
    requirePayload(payload).remote = await new LGaryYangProvider(providerBaseUrl(config), credential).getInfo();
  }

  console.log(JSON.stringify(requirePayload(payload), null, 2));
}

function requirePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) {
    throw new Error('internal error: missing status payload');
  }
  return payload;
}
