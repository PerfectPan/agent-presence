import { configSlotId, getStatePath, loadConfig, providerId, renderTemplates, ttlMs } from '../../config.js';
import { createProvider } from '../../providers/registry.js';
import { renderPresence, resolveUsageForRender } from '../../render.js';
import { usageRenderPlan } from '../usage-badge.js';
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
    const plan = usageRenderPlan(config);
    const { usageVars, autoAppend } = resolveUsageForRender(
      state,
      plan.enabled ? { enabled: true, defaultWindow: plan.defaultWindow } : undefined,
      now
    );
    payload = {
      activeCount: active.length,
      value: renderPresence(active, renderTemplates(config), usageVars, autoAppend),
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
    const provider = createProvider(activeProvider, { config, credential });
    if (credential && provider.getInfo) {
      try {
        remote.slot = await provider.getInfo();
      } catch (error) {
        remote.slotError = error instanceof Error ? error.message : String(error);
      }
    }
    if (provider.getRemotePreview) {
      try {
        remote.faas = await provider.getRemotePreview();
      } catch (error) {
        remote.faasError = error instanceof Error ? error.message : String(error);
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
