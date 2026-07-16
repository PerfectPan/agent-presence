import { configSlotId, debounceMs, getStatePath, loadConfig, providerId, renderTemplates, ttlMs } from '../../config.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsPublish } from '../../providers/types.js';
import { readCredential } from '../../secret.js';
import { resolveHookContextForSource } from '../../sources.js';
import { applyAgentEvent, isSessionBoundaryEvent } from '../../state.js';
import { hasFlag, optionValue } from '../args.js';
import { errorMessage } from '../errors.js';
import { writeHookOutput } from '../hook-context.js';
import { writeHookDiagnostic } from '../hook-diagnostics.js';
import { readStdinJson, writeLog } from '../io.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';
import { refreshSignatureUsageBadges, usageRenderPlan } from '../usage-badge.js';

export async function hook(args: string[]): Promise<void> {
  try {
    const source = optionValue(args, '--source') ?? 'codex';
    const silent = hasFlag(args, '--silent');
    const payload = await readStdinJson();
    const config = await loadConfig();
    const context = await resolveHookContextForSource(source, payload, config);
    const event = optionValue(args, '--event') ?? context.event ?? 'Heartbeat';
    await writeHookDiagnostic({
      source,
      event,
      payload,
      sessionId: context.sessionId,
      project: context.project
    });

    if (!context.sessionId) {
      await writeLog(`hook skipped: missing session id for source=${source} event=${event}`);
      writeHookOutput(silent);
      return;
    }

    const statePath = getStatePath();
    const now = Date.now();

    // Refresh cached usage badges only at session boundaries. Same-day events
    // scan their owning source; the first boundary after midnight scans all
    // built-ins once so inactive sources cannot block the new day's aggregate.
    const usagePlan = usageRenderPlan(config);
    if (usagePlan.enabled && isSessionBoundaryEvent(event)) {
      await refreshSignatureUsageBadges(config, statePath, now, source);
    }

    await syncRenderedSlotWithDeferredFlush(
      statePath,
      {
        force: false,
        now,
        debounceMs: debounceMs(config),
        ttlMs: ttlMs(config),
        renderTemplates: renderTemplates(config),
        usage: { enabled: usagePlan.enabled, defaultWindow: usagePlan.defaultWindow }
      },
      async (value) => {
        // Keep Keychain/provider IO after the local state mutation has been persisted.
        const credential = await readCredential(configSlotId(config));
        const provider = createProvider(providerId(config), { config, credential });
        assertSupportsPublish(provider);
        await provider.publishValue(value);
      },
      (state) => {
        applyAgentEvent(state, {
          source,
          event,
          sessionId: context.sessionId!,
          project: context.project,
          now
        });
      }
    );
  } catch (error) {
    await writeLog(`hook failed: ${errorMessage(error)}`);
  }

  writeHookOutput(hasFlag(args, '--silent'));
}
