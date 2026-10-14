import { getStatePath } from '../config.js';
import { produceRecord } from '../queue/produce.js';
import { hasFlag } from './args.js';
import { errorMessage } from './errors.js';

export function writeHookOutput(silent: boolean): void {
  if (!silent) {
    process.stdout.write('{}\n');
  }
}

/**
 * Record a hook failure as an `error` record whose message is the line the hook logged before the queue
 * (`hook failed: <message>`, Plan 0003 3.11), so the worker logs the same text. A failed recording — the queue could
 * not take this record either — leaves only the hook output (3.10).
 */
export async function recordHookFailure(message: string): Promise<void> {
  try {
    await produceRecord(getStatePath(), { kind: 'error', code: 'hook-failed', message });
  } catch {
    // The event is lost; the run still prints its output and exits 0.
  }
}

// A rejected load of the hook command module must end the run exactly like a
// failure inside it does: the same `hook failed` record and the same hook
// output for the --silent flag, with the exit code left at 0, so a broken
// install never breaks the agent that runs the hook. It covers the load only:
// the hook command handles its own failures, and an error that escapes it
// reaches the generic CLI catch. The dispatcher imports this statically, so
// every command loads what the producer reaches: the queue writer and with it
// `@rivus/agent-kit-collab/process-lock` and `@rivus/agent-kit/node`, which the
// hook path loads anyway, but no schema or zod (test/hook-graph.test.ts).
export async function writeHookLoadFailure(args: string[], error: unknown): Promise<void> {
  await recordHookFailure(`hook failed: ${errorMessage(error)}`);
  writeHookOutput(hasFlag(args, '--silent'));
}
