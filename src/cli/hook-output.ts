import { hasFlag } from './args.js';
import { errorMessage } from './errors.js';
import { writeLog } from './io.js';

export function writeHookOutput(silent: boolean): void {
  if (!silent) {
    process.stdout.write('{}\n');
  }
}

// A rejected load of the hook command module must end the run exactly like a
// failure inside it does: the same `hook failed` log line and the same hook
// output for the --silent flag, with the exit code left at 0, so a broken
// install never breaks the agent that runs the hook. The dispatcher imports
// this statically, which is safe because it pulls in nothing heavy.
export async function writeHookLoadFailure(args: string[], error: unknown): Promise<void> {
  await writeLog(`hook failed: ${errorMessage(error)}`);
  writeHookOutput(hasFlag(args, '--silent'));
}
