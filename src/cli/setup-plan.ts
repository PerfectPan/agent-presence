import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { builtinCodingAgents, isBuiltinCodingAgentId } from '@rivus/agent-kit/catalog';
import {
  CONFLICT_CHOICES,
  locatorKey,
  planInstall,
  type Bundle,
  type ConflictChoice,
  type InstallPlan,
  type PlanConflict,
  type TrustPrompt
} from '@rivus/agent-kit/harness';
import { Effect } from 'effect';
import type { PRESENCE_AGENTS } from '../harness/bundle.js';
import { shellQuote } from '../shell-quote.js';
import { isInteractiveTerminal, promptSelect, showInfo, showNote } from './ui.js';

interface ConflictSelection {
  path: string;
  pointer?: string;
  choice: ConflictChoice;
}

function homePathFormatter(): (path: string) => string {
  const home = resolve(homedir());
  const homes = [home];
  try {
    // Kit locators resolve parent symlinks; command arguments can retain the original home spelling.
    homes.push(realpathSync(home));
  } catch {
    // A missing home still has a useful display path when no canonical spelling is available.
  }
  return (path) => {
    const root = homes.find((candidate) => path === candidate || path.startsWith(`${candidate}${sep}`));
    return root ? `~${path.slice(root.length)}` : path;
  };
}

function entrySummary(plan: InstallPlan, path: string): string {
  const groups = new Map<string, Set<string>>();
  for (const step of plan.steps) {
    const { locator } = step;
    if (
      locator.path !== path ||
      !locator.pointer ||
      step.action === 'noop' ||
      step.removal === 'keep' ||
      step.removal === 'release' ||
      !['json-entry', 'toml-entry', 'managed-block'].includes(locator.kind)
    ) {
      continue;
    }
    const segments = locator.pointer
      .replace(/^\//, '')
      .split('/')
      .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
    const name = segments.pop()!;
    const group = locator.kind === 'managed-block' ? 'block' : segments.join('/');
    const entries = groups.get(group) ?? new Set<string>();
    entries.add(
      `${name}${step.action === 'remove' ? ` (${step.removal === 'restore-pre-image' ? 'restore' : 'remove'})` : ''}`
    );
    groups.set(group, entries);
  }
  return [...groups]
    .map(([group, entries]) => `${group ? `${group} ` : ''}${[...entries].sort().join(', ')}`)
    .join('; ');
}

function agentName(agent: TrustPrompt['agent']): string {
  return isBuiltinCodingAgentId(agent) ? builtinCodingAgents[agent].displayName : agent;
}

function trustLines(prompts: InstallPlan['expectedTrustPrompts'], path: (value: string) => string): string[] {
  const groups = new Map<string, TrustPrompt[]>();
  for (const prompt of prompts) {
    const key = JSON.stringify([prompt.agent, prompt.kind, prompt.locator.path]);
    const group = groups.get(key) ?? [];
    group.push(prompt);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const { agent, kind, locator } = group[0]!;
    const prefix = `${agentName(agent)} will ask you to`;
    switch (kind) {
      case 'hook-review': {
        // A directory prompt covers its plugin's hooks, not a single hook.
        const count = group.every((prompt) => prompt.locator.pointer?.startsWith('/hooks/')) ? group.length : undefined;
        return `${prefix} review ${count ? `${count} hook${count === 1 ? '' : 's'}` : 'hooks'} in ${path(locator.path)}`;
      }
      case 'plugin-consent':
        return `${prefix} enable the plugin in ${path(locator.path)}`;
      case 'folder-trust':
        return `${prefix} trust ${path(locator.path)}`;
    }
  });
}

function showPlan(plan: InstallPlan, selections: readonly ConflictSelection[]): void {
  const path = homePathFormatter();
  const location = (locator: { path: string; pointer?: string }) =>
    `${path(locator.path)}${locator.pointer ? `#${locator.pointer}` : ''}`;
  const commandWord = (word: string) => {
    const shortened = path(word);
    if (shortened === '~' && shortened !== word) {
      return '~';
    }
    return shortened !== word ? `~/${shellQuote(shortened.slice(2))}` : shellQuote(word);
  };
  for (const [title, lines] of [
    [
      'Planned changes',
      plan.changes.map((change) => {
        const action = change.after === undefined ? 'remove' : change.before === undefined ? 'create' : 'update';
        const entries = entrySummary(plan, change.path);
        return `${action} ${path(change.path)}${entries ? `: ${entries}` : ''}`;
      })
    ],
    ['Planned commands', plan.commands.map((command) => [command.command, ...command.args].map(commandWord).join(' '))],
    ['Expected trust prompts', trustLines(plan.expectedTrustPrompts, path)],
    [
      'Notes',
      plan.notes.map(
        ({ locator, note }) =>
          `${location(locator)}: kept because it is ${note === 'dotfiles-managed' ? 'managed by a dotfiles manager' : 'a symlink'}`
      )
    ],
    [
      'Dropped hooks',
      plan.droppedHooks.map(
        ({ agent, firedBy }) =>
          `${agentName(agent)}: no hook of its own for ${firedBy.event}; ${agentName(agent)} runs ${agentName(firedBy.agent)}'s ${firedBy.event} hook in ${path(firedBy.file)}`
      )
    ],
    ['Conflict choices', selections.map((selection) => `${selection.choice} ${location(selection)}`)]
  ] as const) {
    showNote(lines.length ? lines.join('\n') : 'none', title);
  }
}

function allowedChoices({ step, choices }: PlanConflict['conflicts'][number]): readonly ConflictChoice[] {
  const reason = step.conflict;
  if (!reason || reason === 'dotfiles-managed' || reason === 'symlinked-target') {
    return [];
  }
  return choices.filter((choice) => CONFLICT_CHOICES[reason].includes(choice));
}

export function planSetupInstall(bundle: Bundle, agents: readonly (typeof PRESENCE_AGENTS)[number][]) {
  return Effect.gen(function* () {
    const choices: Record<string, ConflictChoice> = {};
    const selections: ConflictSelection[] = [];
    const asked = new Set<string>();

    while (true) {
      const attempt = yield* planInstall(bundle, { agents, choices }).pipe(
        Effect.map((plan) => ({ plan, conflicts: undefined })),
        Effect.catchTag('PlanConflict', (error) => Effect.succeed({ plan: undefined, conflicts: error.conflicts }))
      );
      if (attempt.plan) {
        showPlan(attempt.plan, selections);
        return attempt.plan;
      }

      const conflicts = attempt.conflicts.map((conflict) => ({
        ...conflict,
        allowed: allowedChoices(conflict),
        key: locatorKey(conflict.step.locator),
        location: `${conflict.step.locator.path}${conflict.step.locator.pointer ? `#${conflict.step.locator.pointer}` : ''}`
      }));
      for (const conflict of conflicts) {
        showInfo(
          `setup conflict: ${conflict.location}: ${conflict.step.conflict}; allowed choices: ${conflict.allowed.join(', ') || 'none'}`
        );
      }
      if (
        !isInteractiveTerminal() ||
        conflicts.some((conflict) => conflict.allowed.length === 0) ||
        conflicts.every((conflict) => asked.has(conflict.key))
      ) {
        showInfo(
          'setup stopped: unresolved conflicts; nothing was written to agent configuration. Run setup again after resolving them.'
        );
        process.exitCode = 1;
        return undefined;
      }

      for (const conflict of conflicts) {
        // A shared locator can appear for several agents; one decision covers that locator.
        if (asked.has(conflict.key)) {
          continue;
        }
        asked.add(conflict.key);
        const selected = yield* Effect.tryPromise(() =>
          promptSelect({
            message: `Resolve ${conflict.location} (${conflict.step.conflict})`,
            options: [
              ...conflict.allowed.map((choice) => ({ value: choice, label: choice })),
              { value: 'cancel', label: 'Cancel setup' }
            ]
          })
        );
        const choice = conflict.allowed.find((allowed) => allowed === selected);
        if (!choice) {
          showInfo('setup cancelled: nothing was written to agent configuration');
          process.exitCode = 1;
          return undefined;
        }
        choices[conflict.key] = choice;
        selections.push({ path: conflict.step.locator.path, pointer: conflict.step.locator.pointer, choice });
      }
    }
  });
}
