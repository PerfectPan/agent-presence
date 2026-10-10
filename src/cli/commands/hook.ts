import {
  configSlotId,
  debounceMs,
  getStatePath,
  loadConfig,
  providerId,
  renderTemplates,
  ttlMs
} from '../../config.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsPublish } from '../../providers/types.js';
import { readCredential } from '../../secret.js';
import { resolveHookContextForSource } from '../../sources.js';
import { applyAgentEvent, isSessionBoundaryEvent } from '../../state.js';
import { hasFlag, optionValue } from '../args.js';
import { errorMessage } from '../errors.js';
import { writeHookOutput } from '../hook-output.js';
import { writeHookDiagnostic } from '../hook-diagnostics.js';
import { readStdinJson, writeLog } from '../io.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';
import { appendUsageEvent, usageEventFromPayload } from '../../usage-events.js';
import { interpretAgentHook } from '../hook-interpret.js';
import { refreshSignatureUsageBadges, usageRenderPlan } from '../usage-badge.js';

async function applyHook(options: {
  source: string;
  event: string | undefined;
  payload: unknown;
  silent: boolean;
}): Promise<boolean> {
  const { source, payload, silent } = options;
  const config = await loadConfig();
  const context = await resolveHookContextForSource(source, payload, config);
  const event = options.event ?? context.event ?? 'Heartbeat';
  await writeHookDiagnostic({
    source,
    event,
    payload,
    sessionId: context.sessionId,
    project: context.project
  });

  const sessionId = context.sessionId;
  if (!sessionId) {
    await writeLog(`hook skipped: missing session id for source=${source} event=${event}`);
    writeHookOutput(silent);
    return true;
  }

  const statePath = getStatePath();
  const now = Date.now();

  // Ingest real-time usage reported by a source plugin (dsh) before the
  // boundary refresh below, so a Stop carrying usage is counted in the same
  // boundary's scan. Best-effort: a failed append must never break the hook.
  const usageEvent = usageEventFromPayload(source, payload, now);
  if (usageEvent) {
    await appendUsageEvent(usageEvent).catch(() => {});
  }

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
        sessionId,
        project: context.project,
        now
      });
    }
  );
  return false;
}

async function runAgentHook(args: string[], silent: boolean): Promise<boolean> {
  const agentId = optionValue(args, '--agent');
  if (agentId === undefined || agentId.startsWith('--')) {
    throw new Error('hook --agent requires a kit agent id');
  }
  const payload = await readStdinJson();
  const interpreted = interpretAgentHook(agentId, payload, process.env);
  if (interpreted.kind === 'skip') {
    await writeLog(`hook skipped: ${interpreted.reason}`);
    writeHookOutput(silent);
    return true;
  }
  return applyHook({ source: interpreted.source, event: interpreted.event, payload, silent });
}

async function runSourceHook(args: string[], silent: boolean): Promise<boolean> {
  const source = optionValue(args, '--source') ?? 'codex';
  const payload = await readStdinJson();
  return applyHook({ source, event: optionValue(args, '--event'), payload, silent });
}

export async function hook(args: string[]): Promise<void> {
  const silent = hasFlag(args, '--silent');
  try {
    // True when this run already wrote hook output, which is the skip path.
    const skipped = args.includes('--agent') ? await runAgentHook(args, silent) : await runSourceHook(args, silent);
    if (skipped) {
      return;
    }
  } catch (error) {
    await writeLog(`hook failed: ${errorMessage(error)}`);
  }

  writeHookOutput(silent);
}
