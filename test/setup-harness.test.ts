import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import * as discovery from '@rivus/agent-kit/discovery';
import {
  AgentCli,
  ArtifactFiles,
  LedgerRepository,
  type Bundle,
  type InstallPlan,
  type LedgerScope,
  type PlanConflict
} from '@rivus/agent-kit/harness';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { setup as setupCommand } from '../src/cli/commands/setup.js';
import { installFixtureRuntime } from './runtime-support.js';
import { createPresenceBundle, PRESENCE_AGENTS } from '../src/harness/bundle.js';
import { shellQuote } from '../src/shell-quote.js';
import { packageVersion } from '../src/package-version.js';
import { DSH_PLUGIN_MARKER, resolveDshPluginPaths } from '../src/installers.js';
import { errorMessage } from '../src/cli/errors.js';
import { writePresenceShim } from '../src/harness/shim.js';
import * as runtimeModule from '../src/harness/runtime.js';
import * as shimModule from '../src/harness/shim.js';
import * as installersModule from '../src/installers.js';
import { AGENT_HOME_VARIABLES, createHarnessFixture, type HarnessFixture } from './harness-support.js';

const runtimeNpm = vi.fn<typeof installFixtureRuntime>(installFixtureRuntime);
const setup: typeof setupCommand = (args, takeover, layer, options) =>
  setupCommand(args, takeover, layer, { runNpm: runtimeNpm, ...options });

const ui = vi.hoisted(() => ({
  isInteractiveTerminal: vi.fn<typeof import('../src/cli/ui.js').isInteractiveTerminal>(),
  promptConfirm: vi.fn<typeof import('../src/cli/ui.js').promptConfirm>(),
  promptSelect: vi.fn<typeof import('../src/cli/ui.js').promptSelect>(),
  promptText: vi.fn<typeof import('../src/cli/ui.js').promptText>(),
  showInfo: vi.fn<typeof import('../src/cli/ui.js').showInfo>(),
  showNote: vi.fn<typeof import('../src/cli/ui.js').showNote>(),
  finishOutro: vi.fn<typeof import('../src/cli/ui.js').finishOutro>()
}));
const hooks = vi.hoisted(() => ({
  planInstall: vi.fn<typeof import('@rivus/agent-kit/harness').planInstall>(),
  applyInstall: vi.fn<typeof import('@rivus/agent-kit/harness').applyInstall>(),
  discardPlan: vi.fn<typeof import('@rivus/agent-kit/harness').discardPlan>(),
  verify: vi.fn<typeof import('@rivus/agent-kit/harness').verify>()
}));
const dependencies = vi.hoisted(() => ({
  cleanup: vi.fn<typeof import('../src/migration.js').cleanupMigratedLegacyHome>(),
  hasLegacy: vi.fn<typeof import('../src/migration.js').hasLegacyHomeToMigrate>(),
  migrate: vi.fn<typeof import('../src/migration.js').migrateLegacyHome>(),
  login: vi.fn<typeof import('../src/cli/commands/login.js').login>(),
  hasCredential: vi.fn<typeof import('../src/cli/credential.js').hasCredential>(),
  readCredential: vi.fn<typeof import('../src/secret.js').readCredential>(),
  runScripts: vi.fn<typeof import('../src/setup.js').runSetupScripts>(),
  installDsh: vi.fn<typeof import('../src/installers.js').installDshPlugin>(),
  publish: vi.fn<typeof import('../src/cli/magic-builder-setup.js').publishMagicBuilderFaas>(),
  signatureUrl: vi.fn<typeof import('../src/cli/commands/url.js').resolveSignatureUrl>()
}));

vi.mock('@rivus/agent-kit/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@rivus/agent-kit/harness')>()),
  ...hooks
}));
vi.mock('@rivus/agent-kit/discovery', async (importOriginal) => {
  const original = await importOriginal<typeof import('@rivus/agent-kit/discovery')>();
  return { ...original, detectAgents: vi.fn<typeof original.detectAgents>(original.detectAgents) };
});
vi.mock('../src/cli/ui.js', () => ({
  ...ui,
  startIntro: vi.fn<typeof import('../src/cli/ui.js').startIntro>(),
  createSpinner: () => ({
    start: vi.fn<(message?: string) => void>(),
    stop: vi.fn<(message?: string) => void>(),
    error: vi.fn<(message?: string) => void>()
  })
}));
vi.mock('../src/migration.js', () => ({
  cleanupMigratedLegacyHome: dependencies.cleanup,
  hasLegacyHomeToMigrate: dependencies.hasLegacy,
  migrateLegacyHome: dependencies.migrate
}));
vi.mock('../src/cli/commands/login.js', () => ({ login: dependencies.login }));
vi.mock('../src/cli/credential.js', () => ({ hasCredential: dependencies.hasCredential }));
vi.mock('../src/secret.js', () => ({ readCredential: dependencies.readCredential }));
vi.mock('../src/setup.js', () => ({
  LINUX_WATCHER_SKIP_MESSAGE: 'linux watcher skipped',
  runSetupScripts: dependencies.runScripts
}));
vi.mock('../src/platform.js', () => ({ isMacOS: () => false }));
vi.mock('../src/installers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/installers.js')>()),
  installDshPlugin: dependencies.installDsh
}));
vi.mock('../src/cli/magic-builder-setup.js', () => ({
  MAGIC_TOKEN_HELP: 'fixture token help',
  publishMagicBuilderFaas: dependencies.publish
}));
vi.mock('../src/cli/commands/url.js', () => ({ resolveSignatureUrl: dependencies.signatureUrl }));

let fixture: HarnessFixture;
let realHarness: typeof import('@rivus/agent-kit/harness');
let previousExitCode: typeof process.exitCode;
let errors: ReturnType<typeof vi.spyOn>;
let timeline: string[];
let plans: InstallPlan[];

beforeEach(async () => {
  realHarness = await vi.importActual<typeof import('@rivus/agent-kit/harness')>('@rivus/agent-kit/harness');
  fixture = await createHarnessFixture();
  vi.stubEnv('HOME', fixture.home);
  for (const key of [
    ...AGENT_HOME_VARIABLES,
    'AGENT_PRESENCE_HOME',
    'AGENT_SIGNATURE_HOME',
    'AGENT_PRESENCE_HOOK_COMMAND',
    'AGENT_PRESENCE_CLI_PATH',
    'CODEX_THREAD_ID',
    'CODEX_SESSION_ID',
    'DSH_HOME',
    'DSH_AGENT_PRESENCE_PLUGIN_FILE',
    'DSH_AGENT_PRESENCE_PATCH_FILE'
  ]) {
    vi.stubEnv(key, undefined);
  }
  previousExitCode = process.exitCode;
  process.exitCode = 0;
  vi.clearAllMocks();
  runtimeNpm.mockReset().mockImplementation(installFixtureRuntime);
  dependencies.installDsh.mockReset();
  timeline = [];
  plans = [];
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  ui.isInteractiveTerminal.mockReturnValue(true);
  ui.promptConfirm.mockReset().mockResolvedValue(true);
  ui.promptSelect.mockResolvedValue('cancel');
  ui.showInfo.mockImplementation((message) => timeline.push(message));
  ui.showNote.mockImplementation((message, title) => timeline.push(`${title}: ${message}`));
  dependencies.cleanup.mockResolvedValue({ from: '', to: '', removed: [] });
  dependencies.hasLegacy.mockResolvedValue(false);
  dependencies.hasCredential.mockResolvedValue(true);
  dependencies.login.mockResolvedValue(undefined);
  dependencies.runScripts.mockImplementation(async () => {
    timeline.push('watcher');
    return [];
  });
  dependencies.readCredential.mockResolvedValue({ token: 'fixture-token', slotId: 'fixture-slot' });
  dependencies.signatureUrl.mockResolvedValue('https://example.com/signature');
  dependencies.publish.mockImplementation(async () => {
    timeline.push('publish');
    return {
      tokenSource: 'env',
      id: 'fixture-record',
      recordId: 'fixture-record',
      faasPath: '/api/faas/fixture-record',
      previewPath: '/r?fid=fixture-record',
      isUpdate: false,
      url: 'https://example.com/signature'
    };
  });
  hooks.planInstall.mockImplementation((...args) =>
    realHarness.planInstall(...args).pipe(
      Effect.tap((plan) =>
        Effect.sync(() => {
          plans.push(plan);
          timeline.push('planned');
        })
      )
    )
  );
  hooks.applyInstall.mockImplementation((plan, options) => {
    timeline.push('apply');
    return realHarness.applyInstall(plan, options);
  });
  hooks.discardPlan.mockImplementation(realHarness.discardPlan);
  hooks.verify.mockImplementation((...args) => {
    timeline.push('verify');
    return realHarness.verify(...args);
  });
});

afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.dispose();
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function snapshotTargets(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      const key = relative(fixture.home, target);
      if (entry.isSymbolicLink()) {
        files[key] = `symlink:${await readlink(target)}`;
      } else if (entry.isDirectory()) {
        files[key] = 'directory';
        await walk(target);
      } else {
        files[key] = (await readFile(target)).toString('base64');
      }
    }
  }
  for (const agentHome of ['.claude', '.codex', '.gemini', '.grok', '.config', '.pi']) {
    const path = join(fixture.home, agentHome);
    try {
      await walk(path);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return files;
}

async function seedSettings(): Promise<void> {
  await put(join(fixture.home, '.claude/settings.json'), '{"theme":"dark"}\n');
  await put(join(fixture.home, '.codex/config.toml'), '# keep this comment\nmodel = "fixture-model"\n');
  await put(join(fixture.home, '.gemini/settings.json'), '{"theme":"fixture-theme"}\n');
}

function output(): string {
  return [...timeline, ...errors.mock.calls.flat()].join('\n');
}

function expectStopped(): void {
  expect(process.exitCode).toBe(1);
  expect(hooks.applyInstall).not.toHaveBeenCalled();
  expect(hooks.verify).not.toHaveBeenCalled();
  expect(dependencies.runScripts).not.toHaveBeenCalled();
  expect(dependencies.readCredential).not.toHaveBeenCalled();
  expect(dependencies.publish).not.toHaveBeenCalled();
}

const detectedSetupArguments = ['--skip-login', '--provider', 'magic-builder'];
const argumentsForSetup = [...detectedSetupArguments, '--agents', PRESENCE_AGENTS.join(',')];
const ledgerScope: LedgerScope = { key: 'user', scope: 'user' };

function snapshotLedger() {
  return fixture.run(
    Effect.gen(function* () {
      const repository = yield* LedgerRepository;
      const snapshot = yield* repository.load(ledgerScope);
      if (!snapshot) {
        throw new Error('Expected an installed ledger');
      }
      return snapshot;
    })
  );
}

function readablePreview(codexAvailable: boolean, codexConfigExists = false): [string, string][] {
  return [
    [
      [
        'create ~/.claude/skills/agent-presence/.claude-plugin/plugin.json',
        'create ~/.claude/skills/agent-presence/hooks/hooks.json',
        ...(codexAvailable
          ? [
              'create ~/.codex/plugins/agent-presence/.agents/plugins/marketplace.json',
              'create ~/.codex/plugins/agent-presence/plugins/agent-presence/.codex-plugin/plugin.json',
              'create ~/.codex/plugins/agent-presence/plugins/agent-presence/hooks/hooks.json'
            ]
          : []),
        'create ~/.gemini/extensions/agent-presence/gemini-extension.json',
        'create ~/.gemini/extensions/agent-presence/hooks/hooks.json',
        'create ~/.config/opencode/plugins/agent-presence.js',
        'create ~/.grok/hooks/agent-presence.json',
        'create ~/.pi/agent/extensions/agent-presence.ts',
        ...(!codexAvailable
          ? [
              `${codexConfigExists ? 'update' : 'create'} ~/.codex/config.toml: hooks PreToolUse, SessionStart, Stop, UserPromptSubmit`
            ]
          : [])
      ].join('\n'),
      'Planned changes'
    ],
    [
      codexAvailable
        ? [
            'codex plugin marketplace add ~/.codex/plugins/agent-presence',
            'codex plugin add agent-presence@agent-presence'
          ].join('\n')
        : 'none',
      'Planned commands'
    ],
    [
      codexAvailable
        ? 'Codex will ask you to review hooks in ~/.codex/plugins/agent-presence'
        : 'Codex will ask you to review 4 hooks in ~/.codex/config.toml',
      'Expected trust prompts'
    ],
    ['none', 'Notes'],
    ['none', 'Dropped hooks'],
    ['none', 'Conflict choices']
  ];
}

function withoutAgentCli() {
  return Layer.merge(
    fixture.layer,
    Layer.succeed(AgentCli, {
      available: () => Effect.succeed(false),
      run: () => Effect.die(new Error('A preview must not execute an agent CLI'))
    })
  );
}

function previewFixture(fields: Partial<InstallPlan>): void {
  hooks.planInstall.mockImplementation((...args) =>
    realHarness.planInstall(...args).pipe(
      Effect.map((plan) => {
        hooks.discardPlan.mockImplementationOnce(() => realHarness.discardPlan(plan));
        return {
          ...plan,
          steps: [],
          changes: [],
          commands: [],
          expectedTrustPrompts: [],
          notes: [],
          droppedHooks: [],
          ...fields
        };
      })
    )
  );
}

describe('setup through the harness', () => {
  it.each([['invalid'], [], ['--yes']])(
    'rejects invalid hook-command arguments %j before planning',
    async (...value) => {
      await expect(setup([...argumentsForSetup, '--hook-command', ...value], {}, fixture.layer)).rejects.toSatisfy(
        (error: unknown) => errorMessage(error) === 'invalid --hook-command: expected package, npx, or absolute'
      );

      expect(dependencies.cleanup).not.toHaveBeenCalled();
      expect(hooks.planInstall).not.toHaveBeenCalled();
      expect(ui.promptConfirm).not.toHaveBeenCalled();
      expect(runtimeNpm).not.toHaveBeenCalled();
    }
  );

  it('rejects an invalid hook-command environment override before planning', async () => {
    vi.stubEnv('AGENT_PRESENCE_HOOK_COMMAND', 'invalid');

    await expect(setup(argumentsForSetup, {}, fixture.layer)).rejects.toThrow(
      'invalid AGENT_PRESENCE_HOOK_COMMAND: expected package, npx, or absolute'
    );

    expect(dependencies.cleanup).not.toHaveBeenCalled();
    expect(hooks.planInstall).not.toHaveBeenCalled();
    expect(ui.promptConfirm).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'updates a managed dsh plugin without a plugin prompt (interactive: %s)',
    async (interactive) => {
      const paths = resolveDshPluginPaths();
      await put(paths.pluginPath, `// ${DSH_PLUGIN_MARKER}\nconst command = "npx @rivus/agent-presence@0.10.0";\n`);
      const installers = await vi.importActual<typeof import('../src/installers.js')>('../src/installers.js');
      dependencies.installDsh.mockImplementation(installers.installDshPlugin);
      ui.isInteractiveTerminal.mockReturnValue(interactive);
      ui.promptConfirm.mockResolvedValue(false);
      if (interactive) {
        ui.promptConfirm.mockResolvedValueOnce(true);
      }

      await setup([...argumentsForSetup, '--yes'], {}, fixture.layer);

      expect(process.exitCode).toBe(0);
      expect(ui.promptConfirm.mock.calls).toEqual(interactive ? [['Apply this installation plan?']] : []);
      const plugin = await readFile(paths.pluginPath, 'utf8');
      expect(plugin).toContain(join(fixture.presenceHome, 'bin/agent-presence'));
      expect(plugin).not.toContain('npx');
    }
  );

  it.each([
    { interactive: true, accepted: true },
    { interactive: true, accepted: false },
    { interactive: false, accepted: true }
  ])('installs a fresh dsh plugin only with interactive consent (%j)', async ({ interactive, accepted }) => {
    await mkdir(join(fixture.home, '.dsh'));
    const paths = resolveDshPluginPaths();
    const installers = await vi.importActual<typeof import('../src/installers.js')>('../src/installers.js');
    dependencies.installDsh.mockImplementation(installers.installDshPlugin);
    ui.isInteractiveTerminal.mockReturnValue(interactive);
    ui.promptConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(accepted);

    await setup([...argumentsForSetup, '--yes'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(ui.promptConfirm.mock.calls).toEqual(
      interactive
        ? [['Apply this installation plan?'], ['Install the dsh plugin for presence + token usage reporting?']]
        : []
    );
    expect(existsSync(paths.pluginPath)).toBe(interactive && accepted);
    expect(dependencies.installDsh).toHaveBeenCalledTimes(interactive && accepted ? 1 : 0);
  });

  it('preserves an unmarked dsh plugin during non-interactive setup', async () => {
    const paths = resolveDshPluginPaths();
    await put(paths.pluginPath, '// user plugin\n');
    const installers = await vi.importActual<typeof import('../src/installers.js')>('../src/installers.js');
    dependencies.installDsh.mockImplementation(installers.installDshPlugin);
    ui.isInteractiveTerminal.mockReturnValue(false);

    await setup([...argumentsForSetup, '--yes'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(dependencies.installDsh).not.toHaveBeenCalled();
    expect(await readFile(paths.pluginPath, 'utf8')).toBe('// user plugin\n');
  });

  it.each(['EISDIR', 'EACCES'])(
    'continues publishing and pruning after a dsh plugin read failure (%s)',
    async (code) => {
      const paths = resolveDshPluginPaths();
      const failure = Object.assign(new Error(`${code}: fixture plugin read failed`), { code });
      vi.spyOn(installersModule, 'hasManagedDshPlugin').mockRejectedValueOnce(failure);
      const staleRuntime = join(fixture.presenceHome, 'runtime', '0.8.0');
      await mkdir(staleRuntime, { recursive: true });

      await expect(setup(argumentsForSetup, {}, fixture.layer)).resolves.toBeUndefined();

      expect(process.exitCode).toBe(0);
      expect(errors).not.toHaveBeenCalled();
      expect(ui.showNote.mock.calls.filter(([, title]) => title === 'dsh plugin')).toEqual([
        [`could not read dsh plugin at ${paths.pluginPath}: ${failure.message}`, 'dsh plugin']
      ]);
      expect(ui.promptConfirm.mock.calls).toEqual([['Apply this installation plan?']]);
      expect(dependencies.installDsh).not.toHaveBeenCalled();
      expect(dependencies.publish).toHaveBeenCalledOnce();
      expect(existsSync(staleRuntime)).toBe(false);
      expect(ui.finishOutro).toHaveBeenCalledExactlyOnceWith('setup: ok');
    }
  );

  it('neither reads nor rewrites a marked dsh plugin with --no-hooks', async () => {
    const paths = resolveDshPluginPaths();
    const original = `// ${DSH_PLUGIN_MARKER}\nconst command = "npx @rivus/agent-presence@0.10.0";\n`;
    await put(paths.pluginPath, original);
    const inspect = vi.spyOn(installersModule, 'hasManagedDshPlugin');
    const installers = await vi.importActual<typeof import('../src/installers.js')>('../src/installers.js');
    dependencies.installDsh.mockImplementation(installers.installDshPlugin);

    await setup([...argumentsForSetup, '--no-hooks'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(inspect).not.toHaveBeenCalled();
    expect(dependencies.installDsh).not.toHaveBeenCalled();
    expect(await readFile(paths.pluginPath, 'utf8')).toBe(original);
    expect(existsSync(paths.patchPath)).toBe(false);
    expect(dependencies.publish).toHaveBeenCalledOnce();
    expect(runtimeNpm).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.presenceHome, 'bin/agent-presence'))).toBe(false);
  });

  it.each([
    { interactive: true, codexAvailable: true },
    { interactive: false, codexAvailable: true },
    { interactive: true, codexAvailable: false },
    { interactive: false, codexAvailable: false }
  ])(
    'shows the same readable six-agent preview (interactive=$interactive, codexAvailable=$codexAvailable)',
    async ({ interactive, codexAvailable }) => {
      ui.isInteractiveTerminal.mockReturnValue(interactive);
      ui.promptConfirm.mockResolvedValue(false);

      await setup(argumentsForSetup, {}, codexAvailable ? fixture.layer : withoutAgentCli());

      expectStopped();
      expect(plans[0]?.agents).toEqual(PRESENCE_AGENTS);
      expect(ui.showNote.mock.calls).toEqual(readablePreview(codexAvailable));
      expect(fixture.cliCalls).toEqual([]);
      expect(fixture.processCalls).toEqual([]);
    }
  );

  it('groups added hooks in an existing Codex configuration on one update line', async () => {
    await put(join(fixture.home, '.codex/config.toml'), '# keep this comment\nmodel = "fixture-model"\n');
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, withoutAgentCli());

    expectStopped();
    expect(ui.showNote.mock.calls).toEqual(readablePreview(false, true));
  });

  it('previews TOML hook removals and plugin registration when the Codex CLI becomes available', async () => {
    await put(join(fixture.home, '.codex/config.toml'), '# keep this comment\nmodel = "fixture-model"\n');
    await fixture.writeShim();
    const bundle = createPresenceBundle(fixture.presenceHome);
    const fallbackPlan = await Effect.runPromise(
      realHarness.planInstall(bundle, { agents: PRESENCE_AGENTS }).pipe(Effect.provide(withoutAgentCli()))
    );
    await Effect.runPromise(realHarness.applyInstall(fallbackPlan).pipe(Effect.provide(withoutAgentCli())));
    const before = await snapshotTargets();
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.showNote.mock.calls).toEqual([
      [
        [
          'create ~/.codex/plugins/agent-presence/.agents/plugins/marketplace.json',
          'create ~/.codex/plugins/agent-presence/plugins/agent-presence/.codex-plugin/plugin.json',
          'create ~/.codex/plugins/agent-presence/plugins/agent-presence/hooks/hooks.json',
          'update ~/.codex/config.toml: hooks PreToolUse (remove), SessionStart (remove), Stop (remove), UserPromptSubmit (remove)'
        ].join('\n'),
        'Planned changes'
      ],
      [
        [
          'codex plugin marketplace add ~/.codex/plugins/agent-presence',
          'codex plugin add agent-presence@agent-presence'
        ].join('\n'),
        'Planned commands'
      ],
      ['Codex will ask you to review hooks in ~/.codex/plugins/agent-presence', 'Expected trust prompts'],
      ['none', 'Notes'],
      ['none', 'Dropped hooks'],
      ['none', 'Conflict choices']
    ]);
    expect(await snapshotTargets()).toEqual(before);
    expect(fixture.cliCalls).toEqual([]);
    expect(fixture.processCalls).toEqual([]);
  });

  it('labels entry removals and restores while excluding noop, kept and released entries', async () => {
    const path = join(fixture.home, '.codex/config.toml');
    previewFixture({
      changes: [{ path, before: 'before-marker', after: 'after-marker' }],
      steps: (
        [
          { event: 'DeletedHook', action: 'remove', removal: 'delete' },
          { event: 'RestoredHook', action: 'remove', removal: 'restore-pre-image' },
          { event: 'DefaultRemovalHook', action: 'remove', removal: undefined },
          { event: 'NoopHook', action: 'noop', removal: undefined },
          { event: 'KeptHook', action: 'remove', removal: 'keep' },
          { event: 'ReleasedHook', action: 'remove', removal: 'release' }
        ] as const
      ).map(({ event, action, removal }) => ({
        locator: { kind: 'toml-entry', path, pointer: `/hooks/${event}` },
        agents: [],
        precondition: { absent: true },
        capturePreImage: false,
        action,
        removal
      }))
    });
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.showNote).toHaveBeenCalledWith(
      'update ~/.codex/config.toml: hooks DefaultRemovalHook (remove), DeletedHook (remove), RestoredHook (restore)',
      'Planned changes'
    );
  });

  it('shows file actions without contents and distinguishes absent files from empty files', async () => {
    previewFixture({
      changes: [
        { path: join(fixture.home, 'create-empty.txt'), after: '' },
        { path: join(fixture.home, 'update-empty.txt'), before: '', after: 'new-file-content-marker' },
        { path: join(fixture.home, 'empty-existing.txt'), before: 'old-file-content-marker', after: '' },
        { path: join(fixture.home, 'remove-empty.txt'), before: '' },
        { path: '/work/create.txt', after: 'new-file-content-marker' },
        { path: `${fixture.home}-outside/update.txt`, before: 'old-file-content-marker', after: 'updated' },
        { path: '/work/remove.txt', before: 'old-file-content-marker' }
      ]
    });
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.showNote.mock.calls).toEqual([
      [
        [
          'create ~/create-empty.txt',
          'update ~/update-empty.txt',
          'update ~/empty-existing.txt',
          'remove ~/remove-empty.txt',
          'create /work/create.txt',
          `update ${fixture.home}-outside/update.txt`,
          'remove /work/remove.txt'
        ].join('\n'),
        'Planned changes'
      ],
      ['none', 'Planned commands'],
      ['none', 'Expected trust prompts'],
      ['none', 'Notes'],
      ['none', 'Dropped hooks'],
      ['none', 'Conflict choices']
    ]);
  });

  it('preserves shell quoting for command arguments under the home directory', async () => {
    previewFixture({
      commands: [
        {
          agent: 'codex',
          command: 'codex',
          args: ['plugin', 'marketplace', 'add', join(fixture.home, "plugins with spaces/owner's plugin")],
          purpose: 'register',
          locator: {
            kind: 'cli-registration',
            path: join(fixture.home, '.codex/config.toml'),
            pointer: '/marketplaces'
          }
        }
      ]
    });
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.showNote).toHaveBeenCalledWith(
      "codex plugin marketplace add ~/'plugins with spaces/owner'\\''s plugin'",
      'Planned commands'
    );
  });

  it.each([
    { name: 'a symlinked HOME', suffix: '' },
    { name: 'a symlinked HOME with a trailing slash', suffix: '/' }
  ])('shortens canonical and alias paths and commands under $name', async ({ suffix }) => {
    const canonicalHome = join(await realpath(fixture.home), 'canonical-home');
    const aliasHome = join(fixture.home, 'alias-home');
    await mkdir(canonicalHome);
    await symlink(canonicalHome, aliasHome);
    vi.stubEnv('HOME', `${aliasHome}${suffix}`);
    const outsideCanonical = `${canonicalHome}-outside/file.txt`;
    const outsideAlias = `${aliasHome}-outside/file.txt`;
    previewFixture({
      changes: [
        { path: join(canonicalHome, 'canonical.txt'), after: '' },
        { path: join(aliasHome, 'alias.txt'), after: '' },
        { path: outsideCanonical, after: '' },
        { path: outsideAlias, after: '' },
        { path: '/work/outside.txt', after: '' }
      ],
      commands: [
        {
          agent: 'codex',
          command: join(aliasHome, 'bin/agent tool'),
          args: [
            join(canonicalHome, 'plugins/canonical'),
            join(aliasHome, 'plugins/alias'),
            canonicalHome,
            aliasHome,
            outsideCanonical,
            outsideAlias,
            '/work/outside.txt'
          ],
          purpose: 'register',
          locator: { kind: 'cli-registration', path: join(aliasHome, '.codex/config.toml'), pointer: '/marketplaces' }
        }
      ]
    });
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.showNote).toHaveBeenCalledWith(
      [
        'create ~/canonical.txt',
        'create ~/alias.txt',
        `create ${outsideCanonical}`,
        `create ${outsideAlias}`,
        'create /work/outside.txt'
      ].join('\n'),
      'Planned changes'
    );
    expect(ui.showNote).toHaveBeenCalledWith(
      `~/'bin/agent tool' ~/plugins/canonical ~/plugins/alias ~ ~ ${shellQuote(outsideCanonical)} ${shellQuote(outsideAlias)} /work/outside.txt`,
      'Planned commands'
    );
    expect(fixture.cliCalls).toEqual([]);
    expect(fixture.processCalls).toEqual([]);
  });

  it('explains plugin consent and folder trust prompts by agent and path', async () => {
    previewFixture({
      expectedTrustPrompts: [
        {
          agent: 'claude-code',
          kind: 'plugin-consent',
          locator: { kind: 'dir', path: join(fixture.home, '.claude/skills/agent-presence') }
        },
        {
          agent: 'gemini-cli',
          kind: 'folder-trust',
          locator: { kind: 'dir', path: '/work/project' }
        }
      ]
    });
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.showNote).toHaveBeenCalledWith(
      [
        'Claude Code will ask you to enable the plugin in ~/.claude/skills/agent-presence',
        'Gemini CLI will ask you to trust /work/project'
      ].join('\n'),
      'Expected trust prompts'
    );
  });

  it('uses catalog display names and preserves an unknown agent id in trust prompts', async () => {
    previewFixture({
      expectedTrustPrompts: [
        { agent: 'pi', kind: 'folder-trust', locator: { kind: 'dir', path: '/work/pi' } },
        { agent: 'opencode', kind: 'folder-trust', locator: { kind: 'dir', path: '/work/opencode' } },
        { agent: 'cursor', kind: 'folder-trust', locator: { kind: 'dir', path: '/work/cursor' } },
        { agent: 'custom-agent', kind: 'folder-trust', locator: { kind: 'dir', path: '/work/custom' } }
      ]
    });
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.showNote).toHaveBeenCalledWith(
      [
        'Pi will ask you to trust /work/pi',
        'opencode will ask you to trust /work/opencode',
        'Cursor will ask you to trust /work/cursor',
        'custom-agent will ask you to trust /work/custom'
      ].join('\n'),
      'Expected trust prompts'
    );
  });

  it('explains why dotfiles-managed and symlinked targets are kept', async () => {
    previewFixture({
      notes: [
        {
          locator: { kind: 'toml-entry', path: join(fixture.home, '.codex/config.toml'), pointer: '/hooks/Stop' },
          note: 'dotfiles-managed'
        },
        {
          locator: { kind: 'file', path: join(fixture.home, '.grok/hooks/agent-presence.json') },
          note: 'symlinked-target'
        }
      ]
    });
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.showNote).toHaveBeenCalledWith(
      [
        '~/.codex/config.toml#/hooks/Stop: kept because it is managed by a dotfiles manager',
        '~/.grok/hooks/agent-presence.json: kept because it is a symlink'
      ].join('\n'),
      'Notes'
    );
  });

  it("explains that the dropped agent runs another agent's registration from a kit-style path", async () => {
    previewFixture({
      droppedHooks: [
        {
          agent: 'grok',
          firedBy: {
            agent: 'claude-code',
            event: 'Stop',
            file: '~/.claude/settings.json'
          }
        }
      ]
    });
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.showNote).toHaveBeenCalledWith(
      "Grok: no hook of its own for Stop; Grok runs Claude Code's Stop hook in ~/.claude/settings.json",
      'Dropped hooks'
    );
  });

  it('allows migration and credential writes before planning while preserving all agent targets until confirmation', async () => {
    await seedSettings();
    const before = await snapshotTargets();
    dependencies.hasLegacy.mockResolvedValue(true);
    dependencies.migrate.mockImplementation(async () => {
      timeline.push('migration');
      await put(join(fixture.presenceHome, 'config.json'), '{"provider":"magic-builder","slot_id":"fixture-slot"}\n');
      return {
        status: 'migrated',
        from: 'legacy-home',
        to: 'presence-home',
        copied: ['config.json'],
        skipped: [],
        removed: []
      };
    });
    dependencies.hasCredential.mockResolvedValue(false);
    dependencies.login.mockImplementation(async () => {
      timeline.push('login');
      await put(join(fixture.presenceHome, 'credential-marker'), 'fixture credential stored\n');
    });
    let targetsAtConfirmation: Record<string, string> | undefined;
    ui.promptConfirm.mockImplementation(async () => {
      targetsAtConfirmation = await snapshotTargets();
      return false;
    });

    await setup(['--provider', 'magic-builder', '--agents', PRESENCE_AGENTS.join(',')], {}, fixture.layer);

    expectStopped();
    expect(dependencies.migrate).toHaveBeenCalledOnce();
    expect(dependencies.login).toHaveBeenCalledExactlyOnceWith(['--provider', 'magic-builder']);
    expect(await readFile(join(fixture.presenceHome, 'credential-marker'), 'utf8')).toBe('fixture credential stored\n');
    expect(targetsAtConfirmation).toEqual(before);
    expect(timeline.filter((entry) => ['migration', 'login', 'planned'].includes(entry))).toEqual([
      'migration',
      'login',
      'planned'
    ]);
    expect(await snapshotTargets()).toEqual(before);
  });

  it('keeps every target unchanged through the full preview, applies the exact confirmed handle, then verifies before publishing', async () => {
    await seedSettings();
    await mkdir(join(fixture.home, '.dsh'));
    const before = await snapshotTargets();
    let targetsAtConfirmation: Record<string, string> | undefined;
    let shimExistedAtConfirmation: boolean | undefined;
    let watcherCallsAtConfirmation: number | undefined;
    let noteTitlesAtConfirmation: (string | undefined)[] | undefined;
    let shimModeAtApply: number | undefined;
    let runtimeSection = false;
    const lock = runtimeModule.withPresenceRuntimeLock;
    vi.spyOn(runtimeModule, 'withPresenceRuntimeLock').mockImplementation(async function <A>(action: () => Promise<A>) {
      return lock(async () => {
        runtimeSection = true;
        try {
          return await action();
        } finally {
          runtimeSection = false;
        }
      });
    });
    const writeShim = shimModule.writePresenceShim;
    vi.spyOn(shimModule, 'writePresenceShim').mockImplementation(async (...args) => {
      expect(runtimeSection).toBe(true);
      return writeShim(...args);
    });
    const prune = runtimeModule.prunePresenceRuntimes;
    vi.spyOn(runtimeModule, 'prunePresenceRuntimes').mockImplementation(async (...args) => {
      expect(runtimeSection).toBe(true);
      return prune(...args);
    });

    ui.promptConfirm.mockImplementationOnce(async () => {
      targetsAtConfirmation = await snapshotTargets();
      shimExistedAtConfirmation = existsSync(join(fixture.presenceHome, 'bin/agent-presence'));
      watcherCallsAtConfirmation = dependencies.runScripts.mock.calls.length;
      noteTitlesAtConfirmation = ui.showNote.mock.calls.map(([, title]) => title);
      expect(runtimeNpm).not.toHaveBeenCalled();
      timeline.push('confirm');
      return true;
    });
    ui.promptConfirm.mockImplementationOnce(async () => {
      timeline.push('dsh');
      return false;
    });
    runtimeNpm.mockImplementation(async (command, args) => {
      expect(runtimeSection).toBe(true);
      timeline.push('runtime');
      await installFixtureRuntime(command, args);
    });
    hooks.applyInstall.mockImplementation((plan) =>
      Effect.promise(async () => {
        expect(runtimeSection).toBe(false);
        shimModeAtApply = (await stat(join(fixture.presenceHome, 'bin/agent-presence'))).mode & 0o777;
        timeline.push('apply');
      }).pipe(Effect.andThen(realHarness.applyInstall(plan)))
    );

    await setup(argumentsForSetup, {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    expect(targetsAtConfirmation).toEqual(before);
    expect(shimExistedAtConfirmation).toBe(false);
    expect(watcherCallsAtConfirmation).toBe(0);
    expect(shimModeAtApply).toBe(0o755);
    expect(noteTitlesAtConfirmation).toEqual(
      expect.arrayContaining([
        'Planned changes',
        'Planned commands',
        'Expected trust prompts',
        'Notes',
        'Dropped hooks',
        'Conflict choices'
      ])
    );
    expect(fixture.processCalls).toEqual([]);
    expect(ui.promptConfirm).toHaveBeenNthCalledWith(2, 'Install the dsh plugin for presence + token usage reporting?');
    expect(dependencies.installDsh).not.toHaveBeenCalled();
    expect(hooks.applyInstall).toHaveBeenCalledExactlyOnceWith(plans[0]);
    expect(hooks.verify).toHaveBeenCalledExactlyOnceWith('agent-presence', {
      bundle: createPresenceBundle(fixture.presenceHome),
      agents: PRESENCE_AGENTS
    });
    expect(
      timeline.filter((entry) =>
        ['planned', 'confirm', 'runtime', 'apply', 'watcher', 'dsh', 'publish', 'verify'].includes(entry)
      )
    ).toEqual(['planned', 'confirm', 'runtime', 'apply', 'verify', 'watcher', 'dsh', 'publish']);
    expect(output()).toContain('setup create:');
    expect(output()).toMatch(/verif/i);
    expect(await snapshotTargets()).not.toEqual(before);
  });

  it('discards the displayed handle and stops when confirmation is declined', async () => {
    await seedSettings();
    const before = await snapshotTargets();
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(hooks.discardPlan).toHaveBeenCalledExactlyOnceWith(plans[0]);
    expect(plans[0]?.status).toBe('discarded');
    expect(await snapshotTargets()).toEqual(before);
    await expect(readFile(join(fixture.presenceHome, 'bin/agent-presence'))).rejects.toThrow(/ENOENT/);
    expect(output()).toContain('nothing was written to agent configuration');
  });

  it('still asks for confirmation in a TTY with --yes', async () => {
    const before = await snapshotTargets();
    ui.promptConfirm.mockResolvedValue(false);

    await setup([...argumentsForSetup, '--yes'], {}, fixture.layer);

    expectStopped();
    expect(ui.promptConfirm).toHaveBeenCalledExactlyOnceWith('Apply this installation plan?');
    expect(hooks.discardPlan).toHaveBeenCalledExactlyOnceWith(plans[0]);
    expect(plans[0]?.status).toBe('discarded');
    expect(await snapshotTargets()).toEqual(before);
  });

  it('discards the plan and leaves targets and shim untouched when the runtime install fails', async () => {
    await seedSettings();
    const before = await snapshotTargets();
    let temporaryDirectory: string | undefined;
    runtimeNpm.mockImplementation(async (_command, args) => {
      temporaryDirectory = args[args.indexOf('--prefix') + 1];
      throw new Error('fixture npm offline');
    });

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(process.exitCode).toBe(1);
    expect(errors.mock.calls.flat().join(' ')).toContain('fixture npm offline');
    expect(hooks.discardPlan).toHaveBeenCalledExactlyOnceWith(plans[0]);
    expect(plans[0]?.status).toBe('discarded');
    expect(await snapshotTargets()).toEqual(before);
    expect(existsSync(join(fixture.presenceHome, 'bin/agent-presence'))).toBe(false);
    expect(temporaryDirectory).toBeDefined();
    expect(existsSync(temporaryDirectory!)).toBe(false);
    expect(await readdir(join(fixture.presenceHome, 'runtime'))).toEqual([]);
  });

  it('prunes only after successful setup and retains the runtime referenced by the previous shim', async () => {
    const runtimeHome = join(fixture.presenceHome, 'runtime');
    for (const version of ['0.8.0', '0.9.0']) {
      await mkdir(join(runtimeHome, version), { recursive: true });
    }
    await writePresenceShim(fixture.presenceHome, { version: '0.9.0', mode: 'package' });
    dependencies.runScripts.mockImplementation(async () => {
      expect(await readdir(runtimeHome)).toContain('0.8.0');
      return [];
    });

    await setup(argumentsForSetup, {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect((await readdir(runtimeHome)).sort()).toEqual(['0.9.0', packageVersion()].sort());
  });

  it('keeps the runtime selected by a newer setup when an earlier setup finishes', async () => {
    const newerVersion = '1.2.0';
    dependencies.runScripts.mockImplementationOnce(async () => {
      await setup(argumentsForSetup, {}, fixture.layer, { version: newerVersion });
      return [];
    });

    await setup(argumentsForSetup, {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    const newerCli = join(
      fixture.presenceHome,
      'runtime',
      newerVersion,
      'node_modules/@rivus/agent-presence/dist/src/cli.js'
    );
    expect(existsSync(newerCli)).toBe(true);
    expect(await readFile(join(fixture.presenceHome, 'bin/agent-presence'), 'utf8')).toContain(shellQuote(newerCli));
    expect((await readdir(join(fixture.presenceHome, 'runtime'))).sort()).toEqual(
      [packageVersion(), newerVersion].sort()
    );
  });

  it('does not prune old runtimes when setup stops after applying hooks', async () => {
    const oldRuntime = join(fixture.presenceHome, 'runtime', '0.8.0');
    await mkdir(oldRuntime, { recursive: true });
    dependencies.runScripts.mockRejectedValueOnce(new Error('fixture watcher failure'));

    await expect(setup(argumentsForSetup, {}, fixture.layer)).rejects.toThrow('fixture watcher failure');

    expect(existsSync(oldRuntime)).toBe(true);
  });

  it('discards the plan without applying when writing the shim fails', async () => {
    await seedSettings();
    await put(join(fixture.presenceHome, 'bin'), 'not a directory\n');
    const before = await snapshotTargets();

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(hooks.discardPlan).toHaveBeenCalledExactlyOnceWith(plans[0]);
    expect(plans[0]?.status).toBe('discarded');
    expect(await snapshotTargets()).toEqual(before);
    expect(await readFile(join(fixture.presenceHome, 'bin'), 'utf8')).toBe('not a directory\n');
  });

  it('shows the full plan and requires --yes when the terminal cannot prompt', async () => {
    ui.isInteractiveTerminal.mockReturnValue(false);
    const before = await snapshotTargets();

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.promptConfirm).not.toHaveBeenCalled();
    expect(ui.showNote).toHaveBeenCalledWith(expect.any(String), 'Planned changes');
    expect(output()).toContain('--yes');
    expect(await snapshotTargets()).toEqual(before);
    expect(hooks.discardPlan).toHaveBeenCalledExactlyOnceWith(plans[0]);
  });

  it('applies a conflict-free plan with --yes without prompting', async () => {
    ui.isInteractiveTerminal.mockReturnValue(false);

    await setup([...argumentsForSetup, '--yes'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(ui.promptConfirm).not.toHaveBeenCalled();
    expect(ui.promptSelect).not.toHaveBeenCalled();
    expect(hooks.applyInstall).toHaveBeenCalledExactlyOnceWith(plans[0]);
    expect(hooks.verify).toHaveBeenCalledOnce();
  });

  it.each(['adopt', 'backup'] as const)(
    'resolves an unmanaged file with only allowed choices (%s), shows the full plan, then confirms before writing',
    async (choice) => {
      const path = join(fixture.home, '.pi/agent/extensions/agent-presence.ts');
      const original = '// user extension\n';
      await put(path, original);
      const before = await snapshotTargets();
      const targetsBeforeApply: Record<string, string>[] = [];
      let plansAtChoice: number | undefined;
      let previewShownAtChoice: boolean | undefined;
      let confirmationOutput: string | undefined;
      ui.promptSelect.mockImplementation(async () => {
        targetsBeforeApply.push(await snapshotTargets());
        plansAtChoice = plans.length;
        previewShownAtChoice = ui.showNote.mock.calls.some(([, title]) => title === 'Planned changes');
        timeline.push('choice');
        return choice;
      });
      ui.promptConfirm.mockImplementation(async () => {
        targetsBeforeApply.push(await snapshotTargets());
        confirmationOutput = output();
        timeline.push('confirm');
        return true;
      });

      await setup(argumentsForSetup, {}, fixture.layer);

      expect(process.exitCode).toBe(0);
      expect(ui.promptSelect).toHaveBeenCalledOnce();
      expect(ui.promptSelect.mock.calls[0]?.[0].options.map(({ value }) => value)).toEqual([
        'adopt',
        'backup',
        'cancel'
      ]);
      expect(targetsBeforeApply).toEqual([before, before]);
      expect(plansAtChoice).toBe(0);
      expect(previewShownAtChoice).toBe(false);
      expect(confirmationOutput).toContain(path);
      expect(confirmationOutput).toContain(`Conflict choices: ${choice} ~/.pi/agent/extensions/agent-presence.ts`);
      expect(ui.showNote).toHaveBeenCalledWith(
        `${choice} ~/.pi/agent/extensions/agent-presence.ts`,
        'Conflict choices'
      );
      expect(hooks.planInstall).toHaveBeenCalledTimes(2);
      expect(timeline.indexOf('choice')).toBeLessThan(timeline.indexOf('planned'));
      expect(timeline.indexOf('planned')).toBeLessThan(
        timeline.findIndex((line) => line.startsWith('Planned changes:'))
      );
      expect(timeline.findIndex((line) => line.startsWith('Planned changes:'))).toBeLessThan(
        timeline.indexOf('confirm')
      );
      expect(hooks.applyInstall).toHaveBeenCalledExactlyOnceWith(plans[0]);
      expect(await readFile(path, 'utf8')).not.toBe(original);
    }
  );

  it('cancels an unresolved conflict without confirmation or target writes', async () => {
    await put(join(fixture.home, '.pi/agent/extensions/agent-presence.ts'), '// user extension\n');
    const before = await snapshotTargets();
    ui.promptSelect.mockResolvedValue('cancel');

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(ui.promptConfirm).not.toHaveBeenCalled();
    expect(hooks.planInstall).toHaveBeenCalledOnce();
    expect(await snapshotTargets()).toEqual(before);
    expect(output()).toContain('nothing was written to agent configuration');
  });

  it('asks only for newly reported locators when a later plan repeats an earlier conflict', async () => {
    const bundle = createPresenceBundle(fixture.presenceHome);
    const template = await fixture.run(realHarness.planInstall(bundle, { agents: PRESENCE_AGENTS }));
    const conflict = (agent: 'pi' | 'grok'): PlanConflict['conflicts'][number] => ({
      step: {
        ...template.steps.find((step) => step.agents.includes(agent))!,
        action: 'conflict',
        conflict: 'unmanaged-exists'
      },
      choices: ['adopt', 'backup']
    });
    const pi = conflict('pi');
    const grok = conflict('grok');
    hooks.planInstall
      .mockImplementationOnce(() => Effect.fail({ _tag: 'PlanConflict', planId: 'first-conflict', conflicts: [pi] }))
      .mockImplementationOnce(() =>
        Effect.fail({ _tag: 'PlanConflict', planId: 'second-conflict', conflicts: [pi, grok] })
      );
    ui.promptSelect.mockResolvedValue('adopt');
    ui.promptConfirm.mockResolvedValue(false);
    const before = await snapshotTargets();

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(hooks.planInstall).toHaveBeenCalledTimes(3);
    expect(ui.promptSelect).toHaveBeenCalledTimes(2);
    expect(ui.promptSelect.mock.calls.map(([options]) => options.message)).toEqual([
      expect.stringContaining(pi.step.locator.path),
      expect.stringContaining(grok.step.locator.path)
    ]);
    expect(ui.promptConfirm).toHaveBeenCalledOnce();
    expect(await snapshotTargets()).toEqual(before);
    await fixture.run(realHarness.discardPlan(template));
  });

  it.each([{ flags: [] }, { flags: ['--yes'] }])(
    'refuses non-interactive conflicts with flags $flags',
    async ({ flags }) => {
      ui.isInteractiveTerminal.mockReturnValue(false);
      const path = join(fixture.home, '.pi/agent/extensions/agent-presence.ts');
      await put(path, '// user extension\n');
      const before = await snapshotTargets();

      await setup([...argumentsForSetup, ...flags], {}, fixture.layer);

      expectStopped();
      expect(ui.promptSelect).not.toHaveBeenCalled();
      expect(ui.promptConfirm).not.toHaveBeenCalled();
      expect(output()).toContain(path);
      expect(output()).toContain('unmanaged-exists');
      expect(output()).toContain('adopt, backup');
      expect(await snapshotTargets()).toEqual(before);
    }
  );

  it('offers only force for a user-modified managed artifact', async () => {
    await fixture.writeShim();
    const bundle = createPresenceBundle(fixture.presenceHome);
    await fixture.run(
      realHarness.applyInstall(await fixture.run(realHarness.planInstall(bundle, { agents: PRESENCE_AGENTS })))
    );
    const path = join(fixture.home, '.pi/agent/extensions/agent-presence.ts');
    await writeFile(path, '// changed by user\n');
    const before = await snapshotTargets();
    let targetsAtChoice: Record<string, string> | undefined;
    ui.promptSelect.mockImplementation(async () => {
      targetsAtChoice = await snapshotTargets();
      return 'force';
    });

    await setup(argumentsForSetup, {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(ui.promptSelect).toHaveBeenCalledOnce();
    expect(ui.promptSelect.mock.calls[0]?.[0].options.map(({ value }) => value)).toEqual(['force', 'cancel']);
    expect(targetsAtChoice).toEqual(before);
    expect(output()).toContain('user-modified');
    expect(await readFile(path, 'utf8')).not.toBe('// changed by user\n');
  });

  it('offers only force for an artifact held by another owner', async () => {
    const bundle = createPresenceBundle(fixture.presenceHome);
    const template = await fixture.run(realHarness.planInstall(bundle, { agents: PRESENCE_AGENTS }));
    const step = template.steps.find((entry) => entry.agents.includes('pi'))!;
    hooks.planInstall.mockImplementationOnce(() =>
      Effect.fail({
        _tag: 'PlanConflict',
        planId: 'other-owner-conflict',
        conflicts: [{ step: { ...step, action: 'conflict', conflict: 'other-owner' }, choices: ['force'] }]
      })
    );
    ui.promptSelect.mockResolvedValue('force');
    ui.promptConfirm.mockResolvedValue(false);

    await setup(argumentsForSetup, {}, fixture.layer);

    expectStopped();
    expect(output()).toContain('other-owner');
    expect(ui.promptSelect).toHaveBeenCalledOnce();
    expect(ui.promptSelect.mock.calls[0]?.[0].options.map(({ value }) => value)).toEqual(['force', 'cancel']);
    expect(ui.showNote).toHaveBeenCalledWith('force ~/.pi/agent/extensions/agent-presence.ts', 'Conflict choices');
    await fixture.run(realHarness.discardPlan(template));
  });

  it('reports verification drift and stops before publishing', async () => {
    const locator = { kind: 'file' as const, path: join(fixture.home, '.pi/agent/extensions/agent-presence.ts') };
    hooks.verify.mockReturnValue(
      Effect.succeed({ artifacts: [{ locator, agents: ['pi'], status: 'missing' }], acknowledged: [] })
    );

    await setup(argumentsForSetup, {}, fixture.layer);

    expect(process.exitCode).toBe(1);
    expect(dependencies.runScripts).not.toHaveBeenCalled();
    expect(dependencies.readCredential).not.toHaveBeenCalled();
    expect(dependencies.publish).not.toHaveBeenCalled();
    expect(hooks.verify).toHaveBeenCalledOnce();
    expect(output()).toContain(`verify missing: ${locator.path}`);
    expect(output()).toContain('setup verification failed');
    expect(ui.finishOutro).not.toHaveBeenCalled();
  });

  it('reports verification before a provider-publishing failure using the original message', async () => {
    dependencies.publish.mockImplementation(async () => {
      timeline.push('publish');
      throw new Error('fixture publishing unavailable');
    });

    await setup(argumentsForSetup, {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    expect(hooks.verify).toHaveBeenCalledOnce();
    expect(timeline.indexOf('verify')).toBeLessThan(timeline.indexOf('publish'));
    expect(output()).toContain('verify in-sync:');
    expect(ui.showInfo).toHaveBeenCalledWith('magic-builder setup failed: fixture publishing unavailable');
    expect(ui.showInfo).toHaveBeenCalledWith('signature url: unavailable until publish succeeds');
    expect(ui.finishOutro).toHaveBeenCalledExactlyOnceWith('setup: ok');
  });

  it('keeps signature URL failures outside the harness after reporting verification', async () => {
    const failure = new Error('fixture signature URL unavailable');
    dependencies.signatureUrl.mockImplementation(async () => {
      timeline.push('signature URL');
      throw failure;
    });

    await expect(
      setup(
        ['--skip-login', '--provider', 'feishu-signature', '--agents', PRESENCE_AGENTS.join(',')],
        {},
        fixture.layer
      )
    ).rejects.toBe(failure);

    expect(process.exitCode).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    expect(hooks.verify).toHaveBeenCalledOnce();
    expect(timeline.indexOf('verify')).toBeLessThan(timeline.indexOf('signature URL'));
    expect(output()).toContain('verify in-sync:');
    expect(ui.finishOutro).not.toHaveBeenCalled();
  });

  it('keeps dsh prompt cancellation outside the harness after verification and watcher installation', async () => {
    await mkdir(join(fixture.home, '.dsh'));
    const cancellation = new Error('operation cancelled');
    ui.promptConfirm.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      timeline.push('dsh');
      throw cancellation;
    });

    await expect(setup(argumentsForSetup, {}, fixture.layer)).rejects.toBe(cancellation);

    expect(process.exitCode).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    expect(hooks.verify).toHaveBeenCalledOnce();
    expect(output()).toContain('verify in-sync:');
    expect(dependencies.installDsh).not.toHaveBeenCalled();
    expect(dependencies.runScripts).toHaveBeenCalledOnce();
    expect(timeline.filter((entry) => ['apply', 'verify', 'watcher', 'dsh', 'publish'].includes(entry))).toEqual([
      'apply',
      'verify',
      'watcher',
      'dsh'
    ]);
    expect(dependencies.publish).not.toHaveBeenCalled();
    expect(ui.finishOutro).not.toHaveBeenCalled();
  });

  it.each(['dotfiles-managed', 'symlinked-target', 'combined'] as const)(
    'reports and preserves protected targets (%s) even beside a resolvable conflict',
    async (kind) => {
      const piPath = join(fixture.home, '.pi/agent/extensions/agent-presence.ts');
      const grokPath = join(fixture.home, '.grok/hooks/agent-presence.json');
      if (kind !== 'symlinked-target') {
        await put(piPath, '// dotfiles extension\n');
        fixture.managedPaths.set(await realpath(piPath), 'fixture-dotfiles');
      }
      if (kind !== 'dotfiles-managed') {
        const destination = join(fixture.home, 'shared-hooks.json');
        await put(destination, '{"hooks":{}}\n');
        await mkdir(dirname(grokPath), { recursive: true });
        await symlink(destination, grokPath);
      }
      await put(join(fixture.home, '.claude/skills/agent-presence/keep.txt'), 'foreign plugin\n');
      const before = await snapshotTargets();

      await setup(argumentsForSetup, {}, fixture.layer);

      expectStopped();
      expect(ui.promptConfirm).not.toHaveBeenCalled();
      expect(ui.promptSelect).not.toHaveBeenCalled();
      expect(output()).toContain('unmanaged-exists');
      if (kind !== 'symlinked-target') {
        expect(output()).toContain('dotfiles-managed');
        expect(output()).toContain(piPath);
      }
      if (kind !== 'dotfiles-managed') {
        expect(output()).toContain('symlinked-target');
        expect(output()).toContain(grokPath);
        expect(await readFile(join(fixture.home, 'shared-hooks.json'), 'utf8')).toBe('{"hooks":{}}\n');
      }
      expect(await snapshotTargets()).toEqual(before);
    }
  );

  it('bypasses all harness work and shim creation with --no-hooks', async () => {
    const before = await snapshotTargets();

    await setup([...argumentsForSetup, '--no-hooks'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(hooks.planInstall).not.toHaveBeenCalled();
    expect(hooks.applyInstall).not.toHaveBeenCalled();
    expect(hooks.verify).not.toHaveBeenCalled();
    expect(dependencies.runScripts).not.toHaveBeenCalled();
    expect(dependencies.publish).toHaveBeenCalledOnce();
    expect(await snapshotTargets()).toEqual(before);
    await expect(readFile(join(fixture.presenceHome, 'bin/agent-presence'))).rejects.toThrow(/ENOENT/);
  });

  it.each(['PlanStale', 'TargetChanged'] as const)(
    'reports %s and asks to rerun setup without retrying',
    async (tag) => {
      hooks.applyInstall.mockImplementation((plan) =>
        Effect.fail(
          tag === 'PlanStale'
            ? { _tag: tag, planId: plan.planId, reason: 'ledger-moved', basedOn: plan.basedOn }
            : {
                _tag: tag,
                planId: plan.planId,
                locator: plan.steps[0]!.locator,
                expected: { absent: true },
                completed: 0
              }
        )
      );
      const before = await snapshotTargets();

      await setup(argumentsForSetup, {}, fixture.layer);

      expect(process.exitCode).toBe(1);
      expect(hooks.planInstall).toHaveBeenCalledOnce();
      expect(hooks.applyInstall).toHaveBeenCalledExactlyOnceWith(plans[0]);
      expect(hooks.discardPlan).toHaveBeenCalledExactlyOnceWith(plans[0]);
      expect(plans[0]?.status).toBe('discarded');
      expect(hooks.verify).not.toHaveBeenCalled();
      expect(dependencies.runScripts).not.toHaveBeenCalled();
      expect(dependencies.publish).not.toHaveBeenCalled();
      expect(output()).toContain(tag);
      expect(output()).toMatch(/run.*setup.*again|rerun.*setup/i);
      expect(await snapshotTargets()).toEqual(before);
    }
  );

  it.each(['package', 'npx', 'absolute'] as const)(
    'rewrites the shim from %s to the other mode without changing installed registrations on repeated setup',
    async (initialMode) => {
      vi.stubEnv('AGENT_PRESENCE_CLI_PATH', '/work/presence/dist/src/cli.js');
      await setup([...argumentsForSetup, '--hook-command', initialMode], {}, fixture.layer);
      const before = await snapshotTargets();
      const shim = join(fixture.presenceHome, 'bin/agent-presence');
      const initialShim = await readFile(shim, 'utf8');
      const packageCli = join(
        fixture.presenceHome,
        'runtime',
        packageVersion(),
        'node_modules/@rivus/agent-presence/dist/src/cli.js'
      );
      const expectedCli = initialMode === 'absolute' ? '/work/presence/dist/src/cli.js' : packageCli;
      expect(initialShim).toContain(`${shellQuote(expectedCli)} "$@"`);
      expect(initialShim).not.toContain('npx');
      expect(runtimeNpm).toHaveBeenCalledTimes(initialMode === 'absolute' ? 0 : 1);
      expect(existsSync(join(fixture.presenceHome, 'runtime'))).toBe(initialMode !== 'absolute');

      await setup(
        [...argumentsForSetup, '--hook-command', initialMode === 'absolute' ? 'package' : 'absolute'],
        {},
        fixture.layer
      );

      expect(process.exitCode).toBe(0);
      const nextShim = await readFile(shim, 'utf8');
      expect(nextShim).toContain(
        `${shellQuote(initialMode === 'absolute' ? packageCli : '/work/presence/dist/src/cli.js')} "$@"`
      );
      expect(nextShim).not.toContain('npx');
      expect(runtimeNpm).toHaveBeenCalledOnce();
      expect((await stat(shim)).mode & 0o777).toBe(0o755);
      expect(await snapshotTargets()).toEqual(before);
      expect(plans).toHaveLength(2);
      expect(plans[1]?.changes).toEqual([]);
      expect(plans[1]?.commands).toEqual([]);
      expect(hooks.verify).toHaveBeenCalledTimes(2);
    }
  );
});

describe('setup agent selection', () => {
  it('detects only Claude Code and Codex on the injected PATH and installs and verifies only them', async () => {
    await put(join(fixture.binPath, 'claude'), 'fixture command; never execute\n');
    await put(join(fixture.binPath, 'codex'), 'fixture command; never execute\n');
    const detected = vi.mocked(discovery.detectAgents);

    await setup(detectedSetupArguments, {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(detected).toHaveBeenCalledExactlyOnceWith(fixture.platform, {
      agents: PRESENCE_AGENTS,
      versionProbe: false,
      recipes: expect.any(Object)
    });
    expect(Object.values(detected.mock.calls[0]?.[1]?.recipes ?? {}).map((recipe) => recipe?.auth)).toEqual(
      PRESENCE_AGENTS.map(() => ({}))
    );
    expect(plans).toHaveLength(1);
    expect(new Set(plans[0]?.steps.flatMap(({ agents }) => agents))).toEqual(new Set(['claude-code', 'codex']));
    expect(ui.showNote.mock.calls).toEqual([
      [
        [
          'create ~/.claude/skills/agent-presence/.claude-plugin/plugin.json',
          'create ~/.claude/skills/agent-presence/hooks/hooks.json',
          'create ~/.codex/plugins/agent-presence/.agents/plugins/marketplace.json',
          'create ~/.codex/plugins/agent-presence/plugins/agent-presence/.codex-plugin/plugin.json',
          'create ~/.codex/plugins/agent-presence/plugins/agent-presence/hooks/hooks.json'
        ].join('\n'),
        'Planned changes'
      ],
      [
        [
          'codex plugin marketplace add ~/.codex/plugins/agent-presence',
          'codex plugin add agent-presence@agent-presence'
        ].join('\n'),
        'Planned commands'
      ],
      ['Codex will ask you to review hooks in ~/.codex/plugins/agent-presence', 'Expected trust prompts'],
      ['none', 'Notes'],
      ['none', 'Dropped hooks'],
      ['none', 'Conflict choices'],
      ['https://example.com/signature', 'Signature URL']
    ]);
    expect(hooks.verify).toHaveBeenCalledExactlyOnceWith('agent-presence', {
      bundle: expect.any(Object),
      agents: ['claude-code', 'codex']
    });
    expect(existsSync(join(fixture.home, '.claude/skills/agent-presence'))).toBe(true);
    expect(existsSync(join(fixture.home, '.codex/plugins/agent-presence'))).toBe(true);
    for (const path of ['.grok', '.gemini', '.config/opencode', '.pi']) {
      expect(existsSync(join(fixture.home, path))).toBe(false);
    }
    for (const agent of ['gemini-cli', 'grok', 'opencode', 'pi']) {
      expect(ui.showInfo).toHaveBeenCalledWith(`${agent}: not found; install it and run setup again`);
    }
    expect(output()).not.toContain('unselected agents');
    expect(fixture.processCalls).toEqual([]);
  });

  it('prints no retained-hook notice on a fresh home with one selected agent', async () => {
    await setup([...detectedSetupArguments, '--agents', 'claude-code'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(output()).not.toContain('unselected agents');
    expect(fixture.processCalls).toEqual([]);
  });

  it('detects every agent as missing after an all-agent setup with an empty PATH and installs no further hooks', async () => {
    Object.assign(fixture.platform, { env: { HOME: fixture.home, PATH: '' } });
    ui.isInteractiveTerminal.mockReturnValue(false);
    await setup([...argumentsForSetup, '--yes'], {}, fixture.layer);
    expect(process.exitCode).toBe(0);
    expect(new Set(plans[0]?.steps.flatMap(({ agents }) => agents))).toEqual(new Set(PRESENCE_AGENTS));
    const targets = await snapshotTargets();
    const ledger = await snapshotLedger();
    const writes = vi.spyOn(fixture.platform.fs, 'writeAtomic');
    vi.clearAllMocks();
    fixture.cliCalls.length = 0;
    timeline = [];

    await setup([...detectedSetupArguments, '--yes'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    const detected = vi.mocked(discovery.detectAgents);
    const installations: Awaited<ReturnType<typeof discovery.detectAgents>> = await detected.mock.results[0]?.value;
    expect(installations.map(({ agent, status }) => ({ agent, status }))).toEqual(
      PRESENCE_AGENTS.map((agent) => ({ agent, status: 'missing' }))
    );
    expect(hooks.planInstall).not.toHaveBeenCalled();
    expect(hooks.applyInstall).not.toHaveBeenCalled();
    expect(hooks.verify).not.toHaveBeenCalled();
    expect(ui.promptConfirm).not.toHaveBeenCalled();
    expect(
      writes.mock.calls.filter(([path]) => /\/(?:\.claude|\.codex|\.gemini|\.grok|\.config|\.pi)\//.test(path))
    ).toEqual([]);
    expect(await snapshotTargets()).toEqual(targets);
    expect(await snapshotLedger()).toEqual(ledger);
    expect(output()).toContain('No agents detected; setup installed no hooks.');
    expect(fixture.cliCalls).toEqual([]);
    expect(fixture.processCalls).toEqual([]);
  });

  it('selects only Claude Code when its session store is added after an all-agent setup with an empty PATH', async () => {
    Object.assign(fixture.platform, { env: { HOME: fixture.home, PATH: '' } });
    ui.isInteractiveTerminal.mockReturnValue(false);
    await setup([...argumentsForSetup, '--yes'], {}, fixture.layer);
    expect(process.exitCode).toBe(0);
    expect(new Set(plans[0]?.steps.flatMap(({ agents }) => agents))).toEqual(new Set(PRESENCE_AGENTS));
    await mkdir(join(fixture.home, '.claude/projects'), { recursive: true });
    const targets = await snapshotTargets();
    const unselected = (await snapshotLedger()).entries;
    vi.clearAllMocks();
    fixture.cliCalls.length = 0;
    timeline = [];
    plans = [];

    await setup([...detectedSetupArguments, '--yes'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    const detected = vi.mocked(discovery.detectAgents);
    const installations: Awaited<ReturnType<typeof discovery.detectAgents>> = await detected.mock.results[0]?.value;
    expect(installations.map(({ agent, status }) => ({ agent, status }))).toEqual(
      PRESENCE_AGENTS.map((agent) => ({ agent, status: agent === 'claude-code' ? 'found' : 'missing' }))
    );
    expect(hooks.planInstall.mock.calls[0]?.[1]?.agents).toEqual(['claude-code']);
    expect(hooks.applyInstall).toHaveBeenCalledOnce();
    expect(hooks.verify).toHaveBeenCalledExactlyOnceWith('agent-presence', {
      bundle: expect.any(Object),
      agents: ['claude-code']
    });
    expect(await snapshotTargets()).toEqual(targets);
    expect((await snapshotLedger()).entries).toEqual(unselected);
    expect(fixture.cliCalls).toEqual([]);
    expect(fixture.processCalls).toEqual([]);
  });

  it('names earlier Grok hooks and distinguishes updating them from uninstalling every agent', async () => {
    await setup([...detectedSetupArguments, '--agents', 'grok'], {}, fixture.layer);
    const before = (await fixture.run(realHarness.inventory())).entries;
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((entry) => entry.owners.includes('agent-presence') && entry.agents.includes('grok'))).toBe(
      true
    );
    timeline = [];

    await setup([...detectedSetupArguments, '--agents', 'claude-code'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(ui.showInfo).toHaveBeenCalledWith(
      'Existing hooks for unselected agents (grok) are left unchanged; run agent-presence setup --agents grok to update them. agent-presence uninstall removes presence hooks for all agents.'
    );
    expect(timeline.filter((line) => line.startsWith('Existing hooks for unselected agents'))).toHaveLength(1);
    expect(fixture.processCalls).toEqual([]);
  });

  it('prints no retained-hook notice when the ledger contains only selected agents', async () => {
    await setup([...detectedSetupArguments, '--agents', 'claude-code'], {}, fixture.layer);
    const installed = (await fixture.run(realHarness.inventory())).entries;
    expect(installed.length).toBeGreaterThan(0);
    expect(installed.every((entry) => entry.agents.every((agent) => agent === 'claude-code'))).toBe(true);
    timeline = [];

    await setup([...detectedSetupArguments, '--agents', 'claude-code'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(output()).not.toContain('unselected agents');
    expect(fixture.processCalls).toEqual([]);
  });

  it('ignores unselected ledger entries owned only by another application', async () => {
    const bundle = { ...createPresenceBundle(fixture.presenceHome), owner: 'another-owner' };
    const plan = await fixture.run(realHarness.planInstall(bundle, { agents: ['grok'] }));
    await fixture.run(realHarness.applyInstall(plan));
    const installed = (await fixture.run(realHarness.inventory())).entries;
    expect(installed.length).toBeGreaterThan(0);
    expect(installed.every((entry) => entry.owners.includes('another-owner'))).toBe(true);

    await setup([...detectedSetupArguments, '--agents', 'claude-code'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(output()).not.toContain('unselected agents');
    expect(fixture.processCalls).toEqual([]);
  });

  it('includes shared unselected hooks when presence is an owner but another application is active', async () => {
    const bundle: Bundle = {
      owner: 'agent-presence',
      version: '1.0.0',
      digest: 'shared-skill',
      artifacts: [{ type: 'skill', name: 'shared-skill', files: { 'SKILL.md': '# Shared skill\n' } }]
    };
    const foreignPlan = await fixture.run(
      realHarness.planInstall({ ...bundle, owner: 'another-owner' }, { agents: ['codex'] })
    );
    await fixture.run(realHarness.applyInstall(foreignPlan));
    const presencePlan = await fixture.run(realHarness.planInstall(bundle, { agents: ['codex'] }));
    await fixture.run(realHarness.applyInstall(presencePlan));
    const installed = (await fixture.run(realHarness.inventory())).entries;
    expect(installed.length).toBeGreaterThan(0);
    expect(
      installed.every((entry) => entry.owners.includes('agent-presence') && entry.activeOwner === 'another-owner')
    ).toBe(true);

    await setup([...detectedSetupArguments, '--agents', 'claude-code'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(ui.showInfo).toHaveBeenCalledWith(
      'Existing hooks for unselected agents (codex) are left unchanged; run agent-presence setup --agents codex to update them. agent-presence uninstall removes presence hooks for all agents.'
    );
    expect(fixture.processCalls).toEqual([]);
  });

  it('counts agent-owned evidence without running version commands or reading credential files', async () => {
    const credential = join(fixture.home, '.codex/auth.json');
    await put(credential, '{"fixture":"must not be read"}\n');
    await mkdir(join(fixture.home, '.claude/projects'), { recursive: true });
    const read = vi.spyOn(fixture.platform.fs, 'read');

    await setup(detectedSetupArguments, {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(new Set(plans[0]?.steps.flatMap(({ agents }) => agents))).toEqual(new Set(['claude-code', 'codex']));
    expect(read.mock.calls.map(([path]) => path)).not.toContain(credential);
    expect(fixture.processCalls).toEqual([]);
    expect(await readFile(credential, 'utf8')).toBe('{"fixture":"must not be read"}\n');
  });

  it('lets a deduplicated canonical override bypass discovery and select absent agents', async () => {
    const detected = vi.mocked(discovery.detectAgents);

    await setup([...detectedSetupArguments, '--agents', ' grok, pi, grok '], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(detected).not.toHaveBeenCalled();
    expect(new Set(plans[0]?.steps.flatMap(({ agents }) => agents))).toEqual(new Set(['grok', 'pi']));
    expect(hooks.planInstall.mock.calls[0]?.[1]?.agents).toEqual(['grok', 'pi']);
    expect(hooks.verify).toHaveBeenCalledExactlyOnceWith('agent-presence', {
      bundle: expect.any(Object),
      agents: ['grok', 'pi']
    });
    expect(existsSync(join(fixture.home, '.grok/hooks/agent-presence.json'))).toBe(true);
    expect(existsSync(join(fixture.home, '.pi/agent/extensions/agent-presence.ts'))).toBe(true);
    for (const path of ['.claude', '.codex', '.gemini', '.config/opencode']) {
      expect(existsSync(join(fixture.home, path))).toBe(false);
    }
    expect(output()).not.toContain('not found;');
  });

  it.each([
    { value: ['not-an-agent'], message: 'unsupported setup agent: not-an-agent' },
    { value: ['cursor'], message: 'unsupported setup agent: cursor' },
    { value: ['claude'], message: 'unsupported setup agent: claude' },
    { value: [''], message: 'empty agent id' },
    { value: ['  '], message: 'empty agent id' },
    { value: ['codex,'], message: 'empty agent id' },
    { value: [], message: 'requires a comma-separated list' },
    { value: ['--yes'], message: 'requires a comma-separated list' }
  ])('rejects invalid --agents $value before migration, login or writes', async ({ value, message }) => {
    const before = await snapshotTargets();
    const detected = vi.mocked(discovery.detectAgents);

    await expect(
      setup(['--agents', ...value, '--no-hooks', '--hook-command', 'absolute'], {}, fixture.layer)
    ).rejects.toThrow(message);

    expect(dependencies.cleanup).not.toHaveBeenCalled();
    expect(dependencies.hasLegacy).not.toHaveBeenCalled();
    expect(dependencies.login).not.toHaveBeenCalled();
    expect(dependencies.hasCredential).not.toHaveBeenCalled();
    expect(dependencies.runScripts).not.toHaveBeenCalled();
    expect(dependencies.readCredential).not.toHaveBeenCalled();
    expect(hooks.planInstall).not.toHaveBeenCalled();
    expect(hooks.applyInstall).not.toHaveBeenCalled();
    expect(detected).not.toHaveBeenCalled();
    expect(process.env.AGENT_PRESENCE_HOOK_COMMAND).toBeUndefined();
    expect(await snapshotTargets()).toEqual(before);
    expect(await readdir(fixture.home)).toEqual([]);
  });

  it('prints each missing or unknown agent on one line with failed checks and an override', async () => {
    const path = join(fixture.home, '.grok/sessions');
    const canonicalPath = join(await realpath(fixture.home), '.grok/sessions');
    const originalStat = fixture.platform.fs.stat.bind(fixture.platform.fs);
    // Discovery follows links; legacy target checks must still inspect the actual ancestors.
    vi.spyOn(fixture.platform.fs, 'stat').mockImplementation((target, options) =>
      (target === path || target === canonicalPath) && options?.followSymlinks
        ? Promise.reject(Object.assign(new Error('fixture permission denied'), { code: 'EACCES' }))
        : originalStat(target, options)
    );

    await setup(detectedSetupArguments, {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(ui.showInfo).toHaveBeenCalledWith(
      `grok: detection unknown (${path}: EACCES); use --agents grok to install explicitly`
    );
    expect(timeline.filter((line) => line.startsWith('grok:'))).toHaveLength(1);
    for (const agent of PRESENCE_AGENTS.filter((id) => id !== 'grok')) {
      expect(timeline.filter((line) => line === `${agent}: not found; install it and run setup again`)).toHaveLength(1);
    }
    expect(hooks.planInstall).not.toHaveBeenCalled();
    expect(fixture.processCalls).toEqual([]);
  });

  it('skips agent planning, confirmation and verification when nothing is found but prepares the runtime for independent steps', async () => {
    await mkdir(join(fixture.home, '.dsh'));
    ui.promptConfirm.mockResolvedValue(false);

    await setup(detectedSetupArguments, {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(hooks.planInstall).not.toHaveBeenCalled();
    expect(hooks.applyInstall).not.toHaveBeenCalled();
    expect(hooks.verify).not.toHaveBeenCalled();
    expect(hooks.discardPlan).not.toHaveBeenCalled();
    expect(ui.promptConfirm).toHaveBeenCalledExactlyOnceWith(
      'Install the dsh plugin for presence + token usage reporting?'
    );
    expect(existsSync(join(fixture.presenceHome, 'bin/agent-presence'))).toBe(true);
    expect(runtimeNpm).toHaveBeenCalledOnce();
    expect(dependencies.runScripts).toHaveBeenCalledOnce();
    expect(dependencies.publish).toHaveBeenCalledOnce();
    expect(output()).toContain('No agents detected; setup installed no hooks.');
    expect(ui.finishOutro).toHaveBeenCalledExactlyOnceWith('setup: ok');
    expect(timeline.filter((entry) => ['watcher', 'publish'].includes(entry))).toEqual(['watcher', 'publish']);
  });

  it.each([
    { mode: 'default', args: [] },
    { mode: 'npx', args: ['--hook-command', 'npx'] },
    { mode: 'absolute', args: ['--hook-command', 'absolute'] }
  ])('prepares the $mode shim before a dsh-only setup installs independent components', async ({ mode, args }) => {
    await mkdir(join(fixture.home, '.dsh'));
    vi.stubEnv('AGENT_PRESENCE_CLI_PATH', '/work/presence/dist/src/cli.js');
    const shim = join(fixture.presenceHome, 'bin/agent-presence');
    const packageCli = join(
      fixture.presenceHome,
      'runtime',
      packageVersion(),
      'node_modules/@rivus/agent-presence/dist/src/cli.js'
    );
    const expectedCli = mode === 'absolute' ? '/work/presence/dist/src/cli.js' : packageCli;
    dependencies.runScripts.mockImplementation(async () => {
      expect(existsSync(shim)).toBe(true);
      timeline.push('watcher');
      return [];
    });
    dependencies.installDsh.mockImplementation(async (paths) => {
      const contents = await readFile(shim, 'utf8');
      expect(contents).toContain(`${shellQuote(expectedCli)} "$@"`);
      expect(contents).not.toContain('npx');
      expect((await stat(shim)).mode & 0o777).toBe(0o755);
      expect(existsSync(packageCli)).toBe(mode !== 'absolute');
      timeline.push('dsh');
      return { status: 'installed', ...paths, patchUpdated: true };
    });

    await setup([...detectedSetupArguments, ...args], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(hooks.planInstall).not.toHaveBeenCalled();
    expect(hooks.applyInstall).not.toHaveBeenCalled();
    expect(hooks.verify).not.toHaveBeenCalled();
    expect(runtimeNpm).toHaveBeenCalledTimes(mode === 'absolute' ? 0 : 1);
    expect(dependencies.installDsh).toHaveBeenCalledOnce();
    expect(ui.promptConfirm).toHaveBeenCalledExactlyOnceWith(
      'Install the dsh plugin for presence + token usage reporting?'
    );
    expect(timeline.filter((entry) => ['watcher', 'dsh', 'publish'].includes(entry))).toEqual([
      'watcher',
      'dsh',
      'publish'
    ]);
    expect(await snapshotTargets()).toEqual({});
    expect(fixture.processCalls).toEqual([]);
  });

  it('stops independent setup components when runtime installation fails with no selected agents', async () => {
    await mkdir(join(fixture.home, '.dsh'));
    dependencies.installDsh.mockImplementation(async (paths) => ({
      status: 'installed',
      ...paths,
      patchUpdated: true
    }));
    runtimeNpm.mockRejectedValueOnce(new Error('fixture npm offline'));

    await setup(detectedSetupArguments, {}, fixture.layer);

    expectStopped();
    expect(hooks.planInstall).not.toHaveBeenCalled();
    expect(hooks.discardPlan).not.toHaveBeenCalled();
    expect(dependencies.installDsh).not.toHaveBeenCalled();
    expect(ui.promptConfirm).not.toHaveBeenCalled();
    expect(ui.finishOutro).not.toHaveBeenCalled();
    expect(output()).toContain('fixture npm offline');
    expect(existsSync(join(fixture.presenceHome, 'bin/agent-presence'))).toBe(false);
    expect(await readdir(join(fixture.presenceHome, 'runtime'))).toEqual([]);
    expect(fixture.processCalls).toEqual([]);
  });

  it('leaves earlier Grok files and ledger entries byte-identical and reports no Grok verification after Claude-only setup', async () => {
    await setup([...detectedSetupArguments, '--agents', 'grok'], {}, fixture.layer);
    const path = join(await realpath(fixture.home), '.grok/hooks/agent-presence.json');
    await writeFile(path, '{"hooks":{},"fixture":"user change must remain untouched"}\n');
    const bytes = await readFile(path);
    const before = JSON.stringify(
      Object.entries((await snapshotLedger()).entries).filter(([, entry]) => entry.agents.includes('grok'))
    );
    const reads: string[] = [];
    timeline = [];
    hooks.verify.mockClear();
    hooks.verify.mockImplementation((...args) =>
      Effect.gen(function* () {
        const files = yield* ArtifactFiles;
        return yield* realHarness.verify(...args).pipe(
          Effect.provideService(ArtifactFiles, {
            ...files,
            read: (locator) => {
              reads.push(locator.path);
              if (locator.path === path) {
                return Effect.fail({
                  _tag: 'ArtifactIoFailure' as const,
                  path,
                  operation: 'read' as const,
                  message: 'Unselected Grok artifact is unreadable'
                });
              }
              return files.read(locator);
            }
          })
        );
      })
    );

    await setup([...detectedSetupArguments, '--agents', 'claude-code'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(await readFile(path)).toEqual(bytes);
    expect(
      JSON.stringify(
        Object.entries((await snapshotLedger()).entries).filter(([, entry]) => entry.agents.includes('grok'))
      )
    ).toBe(before);
    expect(hooks.verify).toHaveBeenCalledExactlyOnceWith('agent-presence', {
      bundle: expect.any(Object),
      agents: ['claude-code']
    });
    expect(reads).not.toContain(path);
    expect(timeline.filter((line) => line.startsWith('verify ')).every((line) => !line.includes('/.grok/'))).toBe(true);
    expect(output()).toContain('verify in-sync:');
    expect(output()).toContain(
      'Existing hooks for unselected agents (grok) are left unchanged; run agent-presence setup --agents grok to update them. agent-presence uninstall removes presence hooks for all agents.'
    );
  });

  it('fails setup when native recovery cannot read a pending operation and leaves files and ledger unchanged', async () => {
    await setup([...detectedSetupArguments, '--agents', 'grok'], {}, fixture.layer);
    const installed = await snapshotLedger();
    const entry = Object.values(installed.entries).find((value) => value.agents.includes('grok'))!;
    await fixture.run(
      Effect.gen(function* () {
        const repository = yield* LedgerRepository;
        yield* repository.save(
          ledgerScope,
          {
            ...installed,
            revision: installed.revision + 1,
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
                startedAt: new Date(fixture.platform.clock.now()).toISOString()
              }
            ]
          },
          installed.revision
        );
      })
    );
    const ledger = await snapshotLedger();
    const targets = await snapshotTargets();
    vi.clearAllMocks();
    timeline = [];
    hooks.planInstall.mockImplementation((...args) =>
      Effect.gen(function* () {
        const files = yield* ArtifactFiles;
        return yield* realHarness.planInstall(...args).pipe(
          Effect.provideService(ArtifactFiles, {
            ...files,
            read: (locator) =>
              locator.path === entry.locator.path
                ? Effect.fail({
                    _tag: 'ArtifactIoFailure' as const,
                    path: locator.path,
                    operation: 'read' as const,
                    message: 'Pending operation artifact is unreadable'
                  })
                : files.read(locator)
          })
        );
      })
    );

    await setup([...detectedSetupArguments, '--agents', 'claude-code'], {}, fixture.layer);

    expectStopped();
    expect(hooks.planInstall).toHaveBeenCalledOnce();
    expect(ui.promptConfirm).not.toHaveBeenCalled();
    expect(ui.finishOutro).not.toHaveBeenCalled();
    expect(output()).toContain('ArtifactIoFailure');
    expect(output()).toContain('Pending operation artifact is unreadable');
    expect(await snapshotTargets()).toEqual(targets);
    expect(await snapshotLedger()).toEqual(ledger);
    expect(fixture.processCalls).toEqual([]);
  });
});
