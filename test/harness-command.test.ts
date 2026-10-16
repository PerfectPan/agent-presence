import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { applyInstall, inventory, planInstall, type Bundle } from '@rivus/agent-kit/harness';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as z from 'zod/mini';
import { runCli } from '../src/cli/app.js';
import * as harnessRoot from '../src/cli/harness.js';
import { createPresenceBundle, PRESENCE_AGENTS } from '../src/harness/bundle.js';
import {
  AGENT_HOME_VARIABLES,
  createHarnessFixture,
  HARNESS_NOW,
  plantClaudeDuplicate,
  type HarnessFixture
} from './harness-support.js';

const checksSchema = z.array(
  z.object({ name: z.string(), status: z.enum(['ok', 'warn', 'error']), message: z.string() })
);
const inventorySchema = z.object({
  revision: z.number(),
  entries: z.array(z.object({ agents: z.array(z.string()), owners: z.array(z.string()), appliedAt: z.string() })),
  pending: z.array(z.unknown())
});
const realRunHarness = harnessRoot.runHarness;
let fixture: HarnessFixture;
let previousExitCode: typeof process.exitCode;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  fixture = await createHarnessFixture('presence harness-');
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('AGENT_PRESENCE_HOME', undefined);
  vi.stubEnv('AGENT_SIGNATURE_HOME', undefined);
  for (const key of AGENT_HOME_VARIABLES) {
    vi.stubEnv(key, undefined);
  }
  previousExitCode = process.exitCode;
  process.exitCode = 0;
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(harnessRoot, 'runHarness').mockImplementation((program) => realRunHarness(program, fixture.layer));
});

afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.dispose();
});

async function installBundle() {
  await fixture.writeShim();
  const bundle = createPresenceBundle(fixture.presenceHome);
  const plan = await fixture.run(planInstall(bundle, { agents: PRESENCE_AGENTS }));
  const applied = await fixture.run(applyInstall(plan));
  return { bundle, applied };
}

describe('harness commands', () => {
  it('reports every clean check and the installed inventory revision while fake Codex records registration', async () => {
    const { applied } = await installBundle();
    const checksBefore = await fixture.run(inventory());
    await runCli(['doctor']);
    expect(process.exitCode).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([line]: unknown[]) => line)).toEqual([
      `ok ledger: revision ${applied.ledgerRevision}, ${checksBefore.entries.length} entries`,
      'ok lock: the LedgerLock is free'
    ]);
    log.mockClear();
    await runCli(['doctor', '--json']);
    const checks = z.parse(checksSchema, JSON.parse(z.parse(z.string(), log.mock.calls.at(-1)?.[0])));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check) => check.status === 'ok')).toBe(true);

    log.mockClear();
    await runCli(['inventory', '--json']);
    const result = z.parse(inventorySchema, JSON.parse(z.parse(z.string(), log.mock.calls.at(-1)?.[0])));
    expect(process.exitCode).toBe(0);
    expect(result.revision).toBe(applied.ledgerRevision);
    expect(result.revision).toBeGreaterThan(0);
    expect([...new Set(result.entries.flatMap((entry) => entry.agents))].sort()).toEqual([...PRESENCE_AGENTS].sort());
    expect(result.entries.every((entry) => entry.owners.includes('agent-presence'))).toBe(true);
    expect(result.entries.every((entry) => entry.appliedAt === new Date(HARNESS_NOW).toISOString())).toBe(true);
    expect(result.pending).toEqual([]);

    log.mockClear();
    await runCli(['inventory']);
    expect(log.mock.calls[0]?.[0]).toBe(`Ledger revision: ${result.revision}`);
    expect(log.mock.calls.at(-1)?.[0]).toBe('Pending operations (0):');
    expect(fixture.cliCalls.map(({ command, args }) => [command, ...args])).toEqual([
      ['codex', 'plugin', 'marketplace', 'add', `${fixture.home}/.codex/plugins/agent-presence`],
      ['codex', 'plugin', 'add', 'agent-presence@agent-presence']
    ]);
    expect(fixture.processCalls).toEqual([]);
  });

  it('reports a second marker-carrying Claude hook and exits non-zero', async () => {
    const { bundle } = await installBundle();
    const hook = bundle.artifacts.find((artifact) => artifact.type === 'hooks');
    if (hook === undefined) {
      throw new Error('The presence bundle needs a hook spec');
    }
    await plantClaudeDuplicate(fixture.home, hook.command.replaceAll('{agent}', 'claude-code'));
    await runCli(['doctor', '--json']);
    const checks = z.parse(checksSchema, JSON.parse(z.parse(z.string(), log.mock.calls.at(-1)?.[0])));
    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'duplicate-hook', status: 'warn' })])
    );
    expect(process.exitCode).toBe(1);
    expect(error).not.toHaveBeenCalled();
    expect(fixture.processCalls).toEqual([]);
  });

  it('checks the whole shell-quoted shim path before and after it is removed', async () => {
    await fixture.writeShim();
    const bundle = createPresenceBundle(fixture.presenceHome);
    // One registration keeps the missing-shim finding singular; each event otherwise reports the same path.
    const singleEventBundle: Bundle = {
      ...bundle,
      artifacts: bundle.artifacts.map((artifact) =>
        artifact.type === 'hooks' ? { ...artifact, events: { 'claude-code': ['SessionStart'] } } : artifact
      )
    };
    const plan = await fixture.run(planInstall(singleEventBundle, { agents: ['claude-code'] }));
    await fixture.run(applyInstall(plan));

    await runCli(['doctor', '--json']);
    const presentChecks = z.parse(checksSchema, JSON.parse(z.parse(z.string(), log.mock.calls.at(-1)?.[0])));
    expect(presentChecks.filter((check) => check.name === 'stale-path')).toEqual([]);
    expect(process.exitCode).toBe(0);

    const shimPath = join(fixture.presenceHome, 'bin', 'agent-presence');
    expect(shimPath).toContain(' ');
    await rm(shimPath);
    log.mockClear();
    await runCli(['doctor', '--json']);
    const missingChecks = z.parse(checksSchema, JSON.parse(z.parse(z.string(), log.mock.calls.at(-1)?.[0])));
    expect(missingChecks.filter((check) => check.name === 'stale-path')).toEqual([
      { name: 'stale-path', status: 'warn', message: `${shimPath} does not exist` }
    ]);
    expect(process.exitCode).toBe(1);
    expect(error).not.toHaveBeenCalled();
    expect(fixture.cliCalls).toEqual([]);
    expect(fixture.processCalls).toEqual([]);
  });

  it('prints tagged harness failures with their fields and sets a non-zero exit code', async () => {
    const result = await realRunHarness(
      Effect.fail({ _tag: 'LedgerRepositoryFailure', operation: 'load', message: 'fixture ledger is unreadable' }),
      fixture.layer
    );
    expect(result).toBeUndefined();
    expect(process.exitCode).toBe(1);
    const output = error.mock.calls.flat().join(' ');
    expect(output).toContain('LedgerRepositoryFailure');
    expect(output).toContain('load');
    expect(output).toContain('fixture ledger is unreadable');
    expect(output).not.toContain('[object Object]');
    expect(fixture.processCalls).toEqual([]);
  });
});
