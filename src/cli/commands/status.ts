import { configSlotId, getStatePath, loadConfig, providerId, renderTemplates, ttlMs } from '../../config.js';
import { takeOver, type TakeoverOptions } from '../../queue/takeover.js';
import { createProvider } from '../../providers/registry.js';
import { renderPresence, resolveUsageForRender } from '../../render.js';
import { usageRenderPlan } from '../usage-badge.js';
import { readCredential } from '../../secret.js';
import { getActiveSessions } from '../../state.js';
import { loadState, saveState, withStateLock } from '../../state-store.js';
import { hasFlag, optionValue } from '../args.js';

function requirePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) {
    throw new Error('internal error: missing status payload');
  }
  return payload;
}

export async function printStatus(args: string[], takeover: TakeoverOptions = {}): Promise<void> {
  const config = await loadConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const now = Date.now();
  const statePath = getStatePath();
  const credential = await readCredential(configSlotId(config));
  let payload: Record<string, unknown> | undefined;

  await takeOver(
    statePath,
    async (queue) => {
      // The pending records were recorded before this run; they apply first (Plan 0003 3.7).
      await queue.applyPending();
      await queue.workOffOwed(['dshUsage']);
      await withStateLock(statePath, async () => {
        const state = await loadState(statePath);
        const active = getActiveSessions(state, now, ttlMs(config));
        // Under the tombstone the command changes nothing (Plan 0003 3.8): it prints from the loaded state without
        // saving.
        if (!queue.disabled) {
          await saveState(state, statePath);
        }
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
    },
    takeover
  );

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
