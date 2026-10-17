import { ArtifactFiles, LedgerRepository, applyInstall, planInstall, type LedgerScope } from '@rivus/agent-kit/harness';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { verifySetupInstall } from '../src/cli/setup-verify.js';
import { createPresenceBundle } from '../src/harness/bundle.js';
import { createHarnessFixture, type HarnessFixture } from './harness-support.js';

const scope: LedgerScope = { key: 'user', scope: 'user' };
let fixture: HarnessFixture;

beforeEach(async () => {
  fixture = await createHarnessFixture();
  await fixture.writeShim();
  const plan = await fixture.run(
    planInstall(createPresenceBundle(fixture.presenceHome), { agents: ['gemini-cli', 'grok'] })
  );
  await fixture.run(applyInstall(plan));
});

afterEach(async () => {
  await fixture.dispose();
});

function snapshot() {
  return fixture.run(
    Effect.gen(function* () {
      const repository = yield* LedgerRepository;
      const value = yield* repository.load(scope);
      if (!value) {
        throw new Error('Expected an installed ledger');
      }
      return value;
    })
  );
}

describe('setup verification scope', () => {
  it('does not read or report earlier artifacts for unselected agents', async () => {
    const reads: string[] = [];
    const result = await fixture.run(
      Effect.gen(function* () {
        const files = yield* ArtifactFiles;
        return yield* verifySetupInstall(createPresenceBundle(fixture.presenceHome), ['gemini-cli']).pipe(
          Effect.provideService(ArtifactFiles, {
            ...files,
            read: (locator) => {
              reads.push(locator.path);
              if (locator.path.includes('/.grok/')) {
                return Effect.fail({
                  _tag: 'ArtifactIoFailure' as const,
                  path: locator.path,
                  operation: 'read' as const,
                  message: 'Unselected artifact is unreadable'
                });
              }
              return files.read(locator);
            }
          })
        );
      })
    );

    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.artifacts.every(({ agents, status }) => agents.includes('gemini-cli') && status === 'in-sync')).toBe(
      true
    );
    expect(reads.some((path) => path.includes('/.grok/'))).toBe(false);
  });

  it('preserves unselected ledger entries when acknowledging a selected artifact', async () => {
    const before = await snapshot();
    const selected = Object.entries(before.entries).find(([, entry]) => entry.agents.includes('gemini-cli'))!;
    await fixture.run(
      Effect.gen(function* () {
        const repository = yield* LedgerRepository;
        yield* repository.save(
          scope,
          {
            ...before,
            revision: before.revision + 1,
            entries: {
              ...before.entries,
              [selected[0]]: { ...selected[1], contentHash: `sha256:${'0'.repeat(64)}` }
            }
          },
          before.revision
        );
      })
    );

    const result = await fixture.run(verifySetupInstall(createPresenceBundle(fixture.presenceHome), ['gemini-cli']));

    expect(result.acknowledged).toContainEqual(selected[1].locator);
    expect(result.artifacts.every(({ status }) => status === 'in-sync')).toBe(true);
    const after = await snapshot();
    expect(after.entries).toEqual({
      ...before.entries,
      [selected[0]]: { ...selected[1], entryRevision: after.revision }
    });
    expect(after.revision).toBe(before.revision + 2);
    expect(after.pending).toEqual(before.pending);
    expect(after.kept).toEqual(before.kept);
  });

  it('refuses pending operations without recovering or saving a filtered ledger', async () => {
    const before = await snapshot();
    const reads: string[] = [];
    const saves: Awaited<ReturnType<typeof snapshot>>[] = [];
    const entry = Object.values(before.entries).find((value) => value.agents.includes('grok'))!;
    const result = await fixture.run(
      Effect.gen(function* () {
        const repository = yield* LedgerRepository;
        const files = yield* ArtifactFiles;
        return yield* verifySetupInstall(createPresenceBundle(fixture.presenceHome), ['gemini-cli']).pipe(
          Effect.provideService(LedgerRepository, {
            ...repository,
            load: () =>
              Effect.succeed({
                ...before,
                pending: [
                  {
                    planId: 'fixture-plan',
                    owner: 'agent-presence',
                    bundleVersion: '1.0.0',
                    toolVersion: '1.0.0',
                    locator: entry.locator,
                    action: 'remove',
                    agents: ['grok'],
                    precondition: { hash: entry.contentHash },
                    removal: 'delete',
                    startedAt: '2026-01-01T00:00:00.000Z'
                  }
                ]
              }),
            save: (_scope, value) => {
              saves.push(value);
              return Effect.void;
            }
          }),
          Effect.provideService(ArtifactFiles, {
            ...files,
            read: (locator) => {
              reads.push(locator.path);
              return files.read(locator);
            }
          }),
          Effect.result
        );
      })
    );

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { message: 'Setup verification found pending harness operations; run setup again.' }
    });
    expect(reads).toEqual([]);
    expect(saves).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
});
