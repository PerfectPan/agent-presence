import {
  configSlotId,
  debounceMs,
  getStatePath,
  providerId,
  renderTemplates,
  ttlMs,
  type AppConfig
} from '../../config.js';
import { loadValidatedConfig } from '../../config-schema.js';
import { takeOver, type Takeover, type TakeoverOptions } from '../../queue/takeover.js';
import { createProvider } from '../../providers/registry.js';
import { assertSupportsPublish, type PublishCapableProvider } from '../../providers/types.js';
import type { SyncSlotResult } from '../../render.js';
import { readCredential } from '../../secret.js';
import type { PresenceState } from '../../state.js';
import { hasFlag, optionValue } from '../args.js';
import { syncRenderedSlotWithDeferredFlush } from '../rendered-slot-sync.js';
import { disabledSlotResult } from '../slot-sync.js';
import { usageRenderPlan } from '../usage-badge.js';

/** What the publish commands (`flush`, `reset`, `update`) resolve before their takeover: config, provider, state. */
export interface PublishSetup {
  readonly config: AppConfig;
  /** The provider `--provider` (or the config) names, asserted to support publishing. */
  readonly provider: PublishCapableProvider;
  readonly statePath: string;
  readonly force: boolean;
  readonly silent: boolean;
}

/** Load the config, resolve the publish provider, and read the flags every publish command honors. */
export async function setupPublishCommand(args: string[]): Promise<PublishSetup> {
  const { config } = await loadValidatedConfig();
  const activeProvider = providerId(config, optionValue(args, '--provider'));
  const credential = await readCredential(configSlotId(config));
  const provider = createProvider(activeProvider, { config, credential });
  assertSupportsPublish(provider);
  return {
    config,
    provider,
    statePath: getStatePath(),
    force: hasFlag(args, '--force'),
    silent: hasFlag(args, '--silent')
  };
}

/**
 * The queue settle every publish body shares: pending records apply first, owed usage is worked off unless the
 * command skips it, and `now` is read after the apply so it is never earlier than an applied record's time. A
 * disabled queue ends the run with its disabled result.
 */
export async function settleQueue(
  queue: Takeover,
  statePath: string,
  workOwed = true
): Promise<{ disabled: SyncSlotResult } | { now: number }> {
  await queue.applyPending();
  if (workOwed) {
    await queue.workOffOwed(['dshUsage']);
  }
  if (queue.disabled) {
    return { disabled: await disabledSlotResult(statePath) };
  }
  return { now: Date.now() };
}

/** Run `body` under the state-file takeover, then print the result JSON unless the run is silent. */
export async function runPublishCommand(
  setup: PublishSetup,
  takeover: TakeoverOptions,
  body: (queue: Takeover) => Promise<SyncSlotResult>
): Promise<void> {
  const result = await takeOver(setup.statePath, body, takeover);
  if (!setup.silent) {
    console.log(JSON.stringify(result, null, 2));
  }
}

/** How the rendered publish flow varies per command. */
export interface RenderedPublishOptions {
  /** Whether the run works off owed usage after applying pending records; `reset` skips it. */
  readonly workOwed?: boolean;
  /** Runs after the queue settles and `now` is read, before the slot sync; `update` refreshes usage badges. */
  readonly beforeSync?: (now: number) => Promise<void>;
  /** Extra mutation applied in the same save as the sync; `reset` finishes every session there. */
  readonly mutateState?: (state: PresenceState, now: number) => void;
}

/**
 * The rendered publish flow `flush`, `reset` and `update` share: settle the queue, then sync the rendered slot with
 * the config's render plan and usage window, publishing through the setup's provider.
 */
export async function runRenderedPublish(
  setup: PublishSetup,
  takeover: TakeoverOptions,
  options: RenderedPublishOptions = {}
): Promise<void> {
  const plan = usageRenderPlan(setup.config);
  const mutateState = options.mutateState;
  await runPublishCommand(setup, takeover, async (queue): Promise<SyncSlotResult> => {
    const settled = await settleQueue(queue, setup.statePath, options.workOwed);
    if ('disabled' in settled) {
      return settled.disabled;
    }
    const now = settled.now;
    if (options.beforeSync) {
      await options.beforeSync(now);
    }
    return syncRenderedSlotWithDeferredFlush(
      setup.statePath,
      {
        force: setup.force,
        now,
        debounceMs: debounceMs(setup.config),
        ttlMs: ttlMs(setup.config),
        renderTemplates: renderTemplates(setup.config),
        usage: { enabled: plan.enabled, defaultWindow: plan.defaultWindow }
      },
      (value) => setup.provider.publishValue(value),
      mutateState ? (state) => mutateState(state, now) : undefined
    );
  });
}
