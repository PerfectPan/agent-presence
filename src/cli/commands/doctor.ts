import { doctor as checkHarness, type HarnessServices } from '@rivus/agent-kit/harness';
import type { Layer } from 'effect';
import { createPresenceBundle, PRESENCE_AGENTS } from '../../harness/bundle.js';
import { hasFlag } from '../args.js';
import { runHarness } from '../harness.js';

// Markers must occur in presence's old artifacts and never in foreign files: the kit matches plain substrings.
const PREVIOUS_RELEASE_MARKERS = [
  'agent-presence hook',
  '@rivus/agent-presence',
  'agent-signature hook',
  'agent-signature.mjs hook',
  'AgentSignaturePlugin',
  'runAgentPresence',
  './plugins/agent-presence.js',
  './plugins/agent-signature.js',
  '@rivus/agent-presence pi extension'
] as const;

function doctorProgram() {
  const bundle = createPresenceBundle();
  const installedCommands = bundle.artifacts.flatMap((artifact) =>
    artifact.type === 'hooks' ? PRESENCE_AGENTS.map((agent) => artifact.command.replaceAll('{agent}', agent)) : []
  );
  return checkHarness({
    owner: bundle.owner,
    agents: PRESENCE_AGENTS,
    markers: [...PREVIOUS_RELEASE_MARKERS, ...installedCommands]
  });
}

export async function doctor(args: string[], layer?: Layer.Layer<HarnessServices>): Promise<void> {
  const checks = await runHarness(doctorProgram(), layer);
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
