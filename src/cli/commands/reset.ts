import type { TakeoverOptions } from '../../queue/takeover.js';
import { finishAllSessions } from '../../state.js';
import { runRenderedPublish, setupPublishCommand } from './publish-run.js';

export async function reset(args: string[], takeover: TakeoverOptions = {}): Promise<void> {
  const setup = await setupPublishCommand(args);
  await runRenderedPublish(setup, takeover, {
    // Reset does not collect usage: no owed usage is worked off, and every session finishes in the sync's save.
    workOwed: false,
    mutateState: (state, now) => {
      finishAllSessions(state, now);
    }
  });
}
