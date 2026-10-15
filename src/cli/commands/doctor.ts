import { doctor as checkHarness } from '@rivus/agent-kit/harness';
import { createPresenceBundle, PRESENCE_AGENTS } from '../../harness/bundle.js';
import { hasFlag } from '../args.js';
import { runHarness } from '../harness.js';

function doctorProgram() {
  const bundle = createPresenceBundle();
  const installedCommands = bundle.artifacts.flatMap((artifact) =>
    artifact.type === 'hooks' ? PRESENCE_AGENTS.map((agent) => artifact.command.replaceAll('{agent}', agent)) : []
  );
  return checkHarness({ owner: bundle.owner, agents: PRESENCE_AGENTS, markers: installedCommands });
}

export async function doctor(args: string[]): Promise<void> {
  const checks = await runHarness(doctorProgram());
  if (checks === undefined) {
    return;
  }
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    for (const check of checks) {
      const location = check.locator
        ? ` (${check.locator.path}${check.locator.pointer ? `#${check.locator.pointer}` : ''})`
        : '';
      console.log(`${check.status} ${check.name}: ${check.message}${location}`);
    }
  }
  if (checks.some((check) => check.status !== 'ok')) {
    process.exitCode = 1;
  }
}
