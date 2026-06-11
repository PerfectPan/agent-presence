import {
  configSlotId,
  getStatePath,
  loadConfig,
  magicBuilderBaseUrl,
  magicBuilderFaasId,
  providerBaseUrl,
  providerId,
  renderTemplates,
  ttlMs,
  usageShowInSignature
} from '../../config.js';
import { LGaryYangProvider } from '../../providers/l-garyyang.js';
import { MagicBuilderProvider } from '../../providers/magic-builder.js';
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
    const usage = usageShowInSignature(config) ? state.usageBadge ?? '' : '';
    payload = {
      activeCount: active.length,
      value: renderPresence(active, renderTemplates(config), usage),
      active,
      provider: activeProvider,
      lastValue: state.lastValue ?? '',
      lastSlotUpdateAt: state.lastSlotUpdateAt ?? 0,
      statePath,
      hasToken: Boolean(credential?.token),
      slotId: credential?.slotId ?? configSlotId(config) ?? ''
    };
  });

  if (hasFlag(args, '--remote')) {
    const remote: Record<string, unknown> = {};
    if (credential) {
      try {
        remote.slot = await new LGaryYangProvider(providerBaseUrl(config), credential).getInfo();
      } catch (error) {
        remote.slotError = error instanceof Error ? error.message : String(error);
      }
    }
    if (activeProvider === 'magic-builder') {
      const faasId = magicBuilderFaasId(config);
      if (faasId) {
        try {
          remote.faas = await new MagicBuilderProvider(magicBuilderBaseUrl(config)).invokeFaas(faasId);
        } catch (error) {
          remote.faasError = error instanceof Error ? error.message : String(error);
        }
      } else {
        remote.faasError = 'no published faas id; run `agent-presence setup --provider magic-builder` first';
      }
    }
    if (Object.keys(remote).length > 0) {
      requirePayload(payload).remote = remote;
    }
  }

  console.log(JSON.stringify(requirePayload(payload), null, 2));
}

function requirePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) {
    throw new Error('internal error: missing status payload');
  }
  return payload;
}
