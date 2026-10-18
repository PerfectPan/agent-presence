import { getStatePath } from '../../config.js';
import { stopWorker } from '../../queue/takeover.js';
import { runWorker } from '../../queue/worker.js';
import { hasFlag } from '../args.js';

/**
 * `agent-presence worker`: apply the queue of the state file. Producers, commands and workers start
 * it detached; it is not listed in the help. `worker --stop` takes over, applies what is pending, and writes the
 * tombstone.
 */
export async function worker(args: string[]): Promise<void> {
  const statePath = getStatePath();
  if (hasFlag(args, '--stop')) {
    await stopWorker(statePath);
    return;
  }
  await runWorker({ statePath });
}
