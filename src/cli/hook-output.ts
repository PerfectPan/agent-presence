import { getStatePath } from '../config.js';
import { produceRecord } from '../queue/produce.js';
import { startWorkerProcess, type StartWorker } from '../queue/start-worker.js';
import { hasFlag } from './args.js';
import { errorMessage } from './errors.js';

export function writeHookOutput(silent: boolean): void {
  if (!silent) {
    process.stdout.write('{}\n');
  }
}

// Tests start the worker in process instead of detached (test/hook-producer-support.ts); the hook command and the
// load fallback share this seam.
let startWorker: StartWorker = startWorkerProcess;

/** Test-only: route the producer's worker starts through `override` until restored with `undefined`. */
export function setHookStartWorkerForTests(override: StartWorker | undefined): void {
  startWorker = override ?? startWorkerProcess;
}

/** Start the worker for this process's state file: the injected starter (tests) or a detached one (3.3). */
export function startHookWorker(): void {
  startWorker();
}

/**
 * Record a hook failure as an `error` record whose message is the line the hook logged before the queue
 * (`hook failed: <message>`, Plan 0003 3.11), so the worker logs the same text. Resolves whether the producer wants a
 * worker started for the record (3.3): the caller starts it once, after its own work. A failed recording — the queue
 * could not take this record either — leaves only the hook output (3.10) and starts no worker.
 */
export async function recordHookFailure(message: string): Promise<boolean> {
  try {
    const outcome = await produceRecord(getStatePath(), { kind: 'error', code: 'hook-failed', message });
    return outcome.status === 'recorded' && outcome.startWorker;
  } catch {
    // The event is lost; the run still prints its output and exits 0.
    return false;
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
  const startRequested = await recordHookFailure(`hook failed: ${errorMessage(error)}`);
  if (startRequested) {
    startHookWorker();
  }
  writeHookOutput(hasFlag(args, '--silent'));
}
