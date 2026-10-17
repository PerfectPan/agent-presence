import {
  CONFLICT_CHOICES,
  locatorKey,
  planInstall,
  type Bundle,
  type ConflictChoice,
  type PlanConflict
} from '@rivus/agent-kit/harness';
import { Effect } from 'effect';
import type { PRESENCE_AGENTS } from '../harness/bundle.js';
import { isInteractiveTerminal, promptSelect, showInfo, showNote } from './ui.js';

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
    const selections: { path: string; pointer?: string; choice: ConflictChoice }[] = [];
    const asked = new Set<string>();

    while (true) {
      const attempt = yield* planInstall(bundle, { agents, choices }).pipe(
        Effect.map((plan) => ({ plan, conflicts: undefined })),
        Effect.catchTag('PlanConflict', (error) => Effect.succeed({ plan: undefined, conflicts: error.conflicts }))
      );
      if (attempt.plan) {
        for (const [title, values] of [
          ['Planned changes', attempt.plan.changes],
          ['Planned commands', attempt.plan.commands],
          ['Expected trust prompts', attempt.plan.expectedTrustPrompts],
          ['Notes', attempt.plan.notes],
          ['Dropped hooks', attempt.plan.droppedHooks],
          ['Conflict choices', selections]
        ] as const) {
          showNote(values.length ? JSON.stringify(values, null, 2) : 'none', title);
        }
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
