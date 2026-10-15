import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentCli,
  ExternalOwner,
  FileLedgerRepositoryLive,
  PlatformArtifactFilesLive,
  SqliteLedgerLockLive,
  type AgentCommand,
  type HarnessServices,
  type InstallPlan
} from '@rivus/agent-kit/harness';
import { createNodePlatform } from '@rivus/agent-kit/node';
import { PlatformService } from '@rivus/agent-kit/platform/effect';
import { Effect, Layer } from 'effect';
import * as z from 'zod/mini';

export const HARNESS_NOW = 1_800_000_000_000;
export const AGENT_HOME_VARIABLES = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'GROK_HOME',
  'XDG_DATA_HOME',
  'PI_CODING_AGENT_DIR'
] as const;

export async function createHarnessFixture() {
  const home = await mkdtemp(join(tmpdir(), 'presence-harness-'));
  const presenceHome = join(home, '.agent-presence');
  const node = createNodePlatform({ home, env: { HOME: home, PATH: '' } });
  const cliCalls: AgentCommand[] = [];
  const availableCalls: string[] = [];
  const processCalls: string[] = [];
  let marketplaceAdded = false;
  let pluginAdded = false;

  // The fake models the two registrations and cached copy Codex owns; it never executes a CLI.
  async function registerCodex(command: AgentCommand): Promise<void> {
    cliCalls.push(command);
    const [verb, subject, action] = command.args;
    if (command.command !== 'codex' || verb !== 'plugin') {
      throw new Error(`Unexpected fake agent command: ${command.command}`);
    }
    if (subject === 'marketplace' && action === 'add') {
      marketplaceAdded = true;
    } else if (subject === 'add' && action === 'agent-presence@agent-presence') {
      pluginAdded = true;
      await cp(
        join(home, '.codex/plugins/agent-presence/plugins/agent-presence'),
        join(home, '.codex/plugins/cache/agent-presence/agent-presence/local'),
        { recursive: true }
      );
    } else {
      throw new Error(`Unexpected fake Codex arguments: ${command.args.join(' ')}`);
    }
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex/config.toml'),
      [
        marketplaceAdded ? '[marketplaces]\nagent-presence = true\n' : '',
        pluginAdded ? '[plugins]\n"agent-presence@agent-presence" = true\n' : ''
      ].join('\n')
    );
  }

  const platform = {
    ...node,
    clock: { now: () => HARNESS_NOW, monotonic: () => 1_000 },
    process: {
      ...node.process,
      run: async (command: string) => {
        processCalls.push(command);
        throw new Error(`Unexpected real process.run: ${command}`);
      },
      spawn: (command: string) => {
        processCalls.push(command);
        throw new Error(`Unexpected real process.spawn: ${command}`);
      }
    }
  };
  const layer = Layer.mergeAll(
    PlatformArtifactFilesLive,
    FileLedgerRepositoryLive,
    SqliteLedgerLockLive,
    Layer.succeed(AgentCli, {
      available(command) {
        availableCalls.push(command);
        return Effect.succeed(command === 'codex');
      },
      run(command) {
        return Effect.tryPromise({
          try: async () => {
            await registerCodex(command);
            return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false };
          },
          catch: (error) => ({
            _tag: 'AgentCliFailure' as const,
            ...command,
            reason: 'failed' as const,
            message: error instanceof Error ? error.message : String(error)
          })
        });
      }
    }),
    Layer.succeed(ExternalOwner, { managedPaths: () => Effect.succeed(new Map<string, string>()) })
  ).pipe(Layer.provideMerge(Layer.succeed(PlatformService, platform)));

  return {
    home,
    presenceHome,
    layer,
    cliCalls,
    availableCalls,
    processCalls,
    run<A, E>(program: Effect.Effect<A, E, HarnessServices>): Promise<A> {
      return Effect.runPromise(program.pipe(Effect.provide(layer)));
    },
    async writeShim(): Promise<void> {
      await mkdir(join(presenceHome, 'bin'), { recursive: true });
      await writeFile(join(presenceHome, 'bin/agent-presence'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    },
    dispose: () => rm(home, { recursive: true, force: true })
  };
}

export type HarnessFixture = Awaited<ReturnType<typeof createHarnessFixture>>;

const commandSchema = z.object({ command: z.string(), timeout: z.optional(z.number()) });
const hooksDocumentSchema = z.object({
  hooks: z.record(z.string(), z.array(z.object({ hooks: z.array(commandSchema) })))
});

export interface RenderedRegistration {
  event: string;
  command: string;
  timeout?: number;
}

export function renderedRegistrations(plan: InstallPlan, agent: string): RenderedRegistration[] {
  return plan.steps
    .filter((step) => step.agents.includes(agent))
    .flatMap((step) => {
      const content = step.desired?.content;
      if (step.locator.kind === 'toml-entry') {
        return [{ event: step.locator.pointer?.split('/').at(-1) ?? '', ...z.parse(commandSchema, content) }];
      }
      if (step.locator.kind === 'cli-registration') {
        return [];
      }
      if (step.locator.kind === 'dir' || step.locator.path.endsWith('.json')) {
        const text =
          step.locator.kind === 'dir'
            ? Object.entries(z.parse(z.record(z.string(), z.string()), content)).find(([path]) =>
                path.endsWith('hooks/hooks.json')
              )?.[1]
            : z.parse(z.string(), content);
        const document = z.parse(hooksDocumentSchema, JSON.parse(z.parse(z.string(), text)));
        return Object.entries(document.hooks).flatMap(([event, groups]) =>
          groups.flatMap((group) => group.hooks.map((hook) => ({ event, ...hook })))
        );
      }
      const text = z.parse(z.string(), content);
      const command = z.parse(z.string(), JSON.parse(z.parse(z.string(), /^const COMMAND = (.+)$/m.exec(text)?.[1])));
      const eventPattern =
        agent === 'opencode' ? /^const EVENTS = new Set\((.+)\)$/m : /^const EVENTS: string\[\] = (.+)$/m;
      const events = z.parse(z.array(z.string()), JSON.parse(z.parse(z.string(), eventPattern.exec(text)?.[1])));
      return events.map((event) => ({ event, command }));
    });
}

export async function plantClaudeDuplicate(home: string, command: string): Promise<void> {
  const path = join(home, '.claude/settings.json');
  await writeFile(
    path,
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${command} # duplicate`, timeout: 5 }] }] }
    })
  );
}
