import { detectAgents, type ProbeProblem } from '@rivus/agent-kit/discovery';
import { inventory } from '@rivus/agent-kit/harness';
import { PlatformService } from '@rivus/agent-kit/platform/effect';
import { builtinProviders } from '@rivus/agent-kit/providers';
import { Effect, type Cause } from 'effect';
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

const providers = PRESENCE_AGENTS.flatMap((id) => {
  const discovery = builtinProviders.find((provider) => provider.id === id)?.discovery;
  return discovery ? [{ id, discovery: { ...discovery, auth: {} } }] : [];
});

export function selectSetupAgents(
  override?: readonly PresenceAgent[]
): Effect.Effect<
  readonly PresenceAgent[],
  Effect.Error<ReturnType<typeof inventory>> | Cause.UnknownError,
  Effect.Services<ReturnType<typeof inventory>> | PlatformService
> {
  return Effect.gen(function* () {
    let selected: readonly PresenceAgent[];
    if (override) {
      selected = override;
    } else {
      const platform = yield* PlatformService;
      const installations = yield* Effect.tryPromise(() =>
        detectAgents(platform, { agents: PRESENCE_AGENTS, versionProbe: false, providers })
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
    const installed = yield* inventory();
    const unselected = [
      ...new Set(
        installed.entries
          .filter((entry) => entry.owners.includes('agent-presence'))
          .flatMap((entry) => entry.agents)
          .filter((agent) => !selected.some((id) => id === agent))
      )
    ].sort();
    if (unselected.length > 0) {
      showInfo(
        `Existing hooks for unselected agents (${unselected.join(', ')}) are left unchanged; run agent-presence setup --agents ${unselected.join(',')} to update them. agent-presence uninstall removes presence hooks for all agents.`
      );
    }
    return selected;
  });
}
