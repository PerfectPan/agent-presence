import { configSlotId, debounceMs, getStatePath, loadConfig, providerBaseUrl, providerId, renderTemplates, ttlMs } from '../../config.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsSlotUpdate } from '../../providers/types.js';
import { readCredential } from '../../secret.js';
import { applyAgentEvent } from '../../state.js';
import { hasFlag, optionValue } from '../args.js';
import { errorMessage } from '../errors.js';
import { resolveHookContext, writeHookOutput } from '../hook-context.js';
import { readStdinJson, writeLog } from '../io.js';
import { syncRenderedSlotWithStateLock } from '../slot-sync.js';

export async function hook(args: string[]): Promise<void> {
  try {
    const source = optionValue(args, '--source') ?? 'codex';
    const silent = hasFlag(args, '--silent');
    const payload = await readStdinJson();
    const context = resolveHookContext(source, payload);
    const event = optionValue(args, '--event') ?? context.event ?? 'Heartbeat';

    if (!context.sessionId) {
      await writeLog(`hook skipped: missing session id for source=${source} event=${event}`);
      writeHookOutput(silent);
      return;
    }

    const config = await loadConfig();
    const credential = await readCredential(configSlotId(config));
    const provider = createProvider(providerId(config), { baseUrl: providerBaseUrl(config), credential });
    assertSupportsSlotUpdate(provider);
    const statePath = getStatePath();
    const now = Date.now();

    await syncRenderedSlotWithStateLock(
      statePath,
      {
        force: false,
        now,
        debounceMs: debounceMs(config),
        ttlMs: ttlMs(config),
        renderTemplates: renderTemplates(config)
      },
      (value) => provider.updateSlot(value),
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
