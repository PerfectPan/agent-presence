import { configSlotId, debounceMs, getStatePath, loadConfig, providerBaseUrl, renderTemplates, ttlMs, usageShowInSignature } from '../../config.js';
import { LGaryYangProvider } from '../../providers/l-garyyang.js';
import { readCredential } from '../../secret.js';
import { applyAgentEvent, isSessionBoundaryEvent } from '../../state.js';
import { hasFlag, optionValue } from '../args.js';
import { errorMessage } from '../errors.js';
import { resolveHookContext, writeHookOutput } from '../hook-context.js';
import { writeHookDiagnostic } from '../hook-diagnostics.js';
import { readStdinJson, writeLog } from '../io.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';
import { refreshSignatureUsageBadge } from '../usage-badge.js';

export async function hook(args: string[]): Promise<void> {
  try {
    const source = optionValue(args, '--source') ?? 'codex';
    const silent = hasFlag(args, '--silent');
    const payload = await readStdinJson();
    const context = resolveHookContext(source, payload);
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

    const config = await loadConfig();
    const statePath = getStatePath();
    const now = Date.now();

    // Refresh the cached usage badge only at session boundaries; other events
    // reuse the cached value, so high-frequency tool events do no scanning.
    const usageEnabled = usageShowInSignature(config);
    if (usageEnabled && isSessionBoundaryEvent(event)) {
      await refreshSignatureUsageBadge(config, statePath, now);
    }

    await syncRenderedSlotWithDeferredFlush(
      statePath,
      {
        force: false,
        now,
        debounceMs: debounceMs(config),
        ttlMs: ttlMs(config),
        renderTemplates: renderTemplates(config),
        usageEnabled
      },
      async (value) => {
        // Keep Keychain/provider IO after the local state mutation has been persisted.
        const credential = await readCredential(configSlotId(config));
        const provider = new LGaryYangProvider(providerBaseUrl(config), credential);
        await provider.updateSlot(value);
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
