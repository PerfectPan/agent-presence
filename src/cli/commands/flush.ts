import type { TakeoverOptions } from '../../queue/takeover.js';
import { runRenderedPublish, setupPublishCommand } from './publish-run.js';

/** Publish the latest cached presence state without collecting usage. */
export async function flush(args: string[], takeover: TakeoverOptions = {}): Promise<void> {
  const setup = await setupPublishCommand(args);
  await runRenderedPublish(setup, takeover);
}
