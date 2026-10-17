import { builtinProbeRecipes, detectAgents, type ProbeProblem } from '@rivus/agent-kit/discovery';
import { PlatformService } from '@rivus/agent-kit/platform/effect';
import { Effect } from 'effect';
import { PRESENCE_AGENTS } from '../harness/bundle.js';
import { showInfo } from './ui.js';

type PresenceAgent = (typeof PRESENCE_AGENTS)[number];

export function parseSetupAgents(args: readonly string[]): PresenceAgent[] | undefined {
  const index = args.indexOf('--agents');
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('setup --agents requires a comma-separated list of agent ids');
  }
  const selected: PresenceAgent[] = [];
  for (const entry of value.split(',')) {
    const id = entry.trim();
    if (!id) {
      throw new Error('setup --agents must not contain an empty agent id');
    }
    const agent = PRESENCE_AGENTS.find((supported) => supported === id);
    if (!agent) {
      throw new Error(`unsupported setup agent: ${id}; supported ids: ${PRESENCE_AGENTS.join(', ')}`);
    }
    if (!selected.includes(agent)) {
      selected.push(agent);
    }
  }
  return selected;
}

function describeProblem(problem: ProbeProblem): string {
  switch (problem._tag) {
    case 'StatFailed':
      return `${problem.path}: ${problem.code}`;
    case 'CommandFailed':
      return `${problem.path}: ${problem.purpose} ${problem.reason}`;
    case 'CredentialFileFailed':
      return `${problem.path}: ${problem.code ?? problem.reason}`;
  }
}

const recipes = Object.fromEntries(
  PRESENCE_AGENTS.map((agent) => [agent, { ...builtinProbeRecipes[agent], auth: {} }])
);

export function selectSetupAgents(override?: readonly PresenceAgent[]) {
  return Effect.gen(function* () {
    let selected: readonly PresenceAgent[];
    if (override) {
      selected = override;
    } else {
      const platform = yield* PlatformService;
      const installations = yield* Effect.tryPromise(() =>
        detectAgents(platform, { agents: PRESENCE_AGENTS, versionProbe: false, recipes })
      );
      for (const installation of installations) {
        if (installation.status === 'missing') {
          showInfo(`${installation.agent}: not found; install it and run setup again`);
        } else if (installation.status === 'unknown') {
          showInfo(
            `${installation.agent}: detection unknown (${installation.problems.map(describeProblem).join('; ')}); use --agents ${installation.agent} to install explicitly`
          );
        }
      }
      selected = PRESENCE_AGENTS.filter((agent) =>
        installations.some(
          (installation) =>
            installation.agent === agent && (installation.status === 'found' || installation.status === 'runnable')
        )
      );
    }
    if (selected.length < PRESENCE_AGENTS.length) {
      showInfo('Existing artifacts for unselected agents are left unchanged; run uninstall to remove them.');
    }
    return selected;
  });
}
