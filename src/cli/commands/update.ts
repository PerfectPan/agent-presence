import { debounceMs } from '../../config.js';
import { settleRenderedSync } from '../../queue/owed.js';
import type { TakeoverOptions } from '../../queue/takeover.js';
import type { SyncSlotResult } from '../../render.js';
import { optionValue } from '../args.js';
import { syncExplicitSlotValueWithStateLock } from '../slot-sync.js';
import { refreshSignatureUsageBadges, usageRenderPlan } from '../usage-badge.js';
import { runPublishCommand, runRenderedPublish, settleQueue, setupPublishCommand } from './publish-run.js';

export async function update(args: string[], takeover: TakeoverOptions = {}): Promise<void> {
  const setup = await setupPublishCommand(args);
  const explicitValue = optionValue(args, '--value');

  if (explicitValue !== undefined) {
    await runPublishCommand(setup, takeover, async (queue): Promise<SyncSlotResult> => {
      // The pending records were recorded before this run; they apply first.
      const settled = await settleQueue(queue, setup.statePath);
      if ('disabled' in settled) {
        return settled.disabled;
      }
      return syncExplicitSlotValueWithStateLock(
        setup.statePath,
        {
          force: setup.force,
          now: settled.now,
          debounceMs: debounceMs(setup.config),
          value: explicitValue.slice(0, 200)
        },
        (value) => setup.provider.publishValue(value),
        // The explicit value is the one the slot keeps: settle the owed rendered sync in the save that records it,
        // so a later worker does not overwrite it with the rendered one.
        settleRenderedSync
      );
    });
    return;
  }

  await runRenderedPublish(setup, takeover, {
    // An explicit update is infrequent, so establish a complete usage snapshot
    // before rendering. Hook boundaries are source-scoped after the day's first
    // boundary has established a complete built-in snapshot.
    beforeSync: async (now) => {
      if (usageRenderPlan(setup.config).enabled) {
        await refreshSignatureUsageBadges(setup.config, setup.statePath, now);
      }
    }
  });
}
