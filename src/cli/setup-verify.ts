import { LedgerRepository, verify, type Bundle } from '@rivus/agent-kit/harness';
import { Effect } from 'effect';
import type { PRESENCE_AGENTS } from '../harness/bundle.js';

export function verifySetupInstall(bundle: Bundle, agents: typeof PRESENCE_AGENTS) {
  return Effect.gen(function* () {
    const repository = yield* LedgerRepository;
    return yield* verify('agent-presence', { bundle, agents }).pipe(
      Effect.provideService(LedgerRepository, {
        ...repository,
        load: (scope) =>
          repository.load(scope).pipe(
            Effect.flatMap((snapshot) => {
              // Recovery needs the full ledger; never let verify recover pending work through a filtered view.
              if (snapshot?.pending.length) {
                return Effect.fail({
                  _tag: 'LedgerRepositoryFailure' as const,
                  scope: scope.key,
                  reason: 'io' as const,
                  message: 'Setup verification found pending harness operations; run setup again.'
                });
              }
              return Effect.succeed(
                snapshot && {
                  ...snapshot,
                  entries: Object.fromEntries(
                    Object.entries(snapshot.entries).filter(([, entry]) =>
                      entry.agents.some((agent) => agents.some((selected) => selected === agent))
                    )
                  )
                }
              );
            })
          ),
        // The kit holds the ledger lock here. Restore unselected entries before its revision-checked save.
        save: (scope, snapshot, expectedRevision) =>
          repository
            .load(scope)
            .pipe(
              Effect.flatMap((full) =>
                repository.save(
                  scope,
                  { ...snapshot, entries: { ...full?.entries, ...snapshot.entries } },
                  expectedRevision
                )
              )
            )
      })
    );
  });
}
