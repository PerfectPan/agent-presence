import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import * as discovery from '@rivus/agent-kit/discovery';
import { AgentCli, type InstallPlan, type PlanConflict } from '@rivus/agent-kit/harness';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { setup } from '../src/cli/commands/setup.js';
import { createPresenceBundle, PRESENCE_AGENTS } from '../src/harness/bundle.js';
import { shellQuote } from '../src/shell-quote.js';
import { AGENT_HOME_VARIABLES, createHarnessFixture, type HarnessFixture } from './harness-support.js';

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
    'DSH_HOME'
  ]) {
    vi.stubEnv(key, undefined);
  }
  previousExitCode = process.exitCode;
  process.exitCode = 0;
  vi.clearAllMocks();
  timeline = [];
  plans = [];
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  ui.isInteractiveTerminal.mockReturnValue(true);
  ui.promptConfirm.mockResolvedValue(true);
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
    ui.promptConfirm.mockImplementationOnce(async () => {
      targetsAtConfirmation = await snapshotTargets();
      shimExistedAtConfirmation = existsSync(join(fixture.presenceHome, 'bin/agent-presence'));
      watcherCallsAtConfirmation = dependencies.runScripts.mock.calls.length;
      noteTitlesAtConfirmation = ui.showNote.mock.calls.map(([, title]) => title);
      timeline.push('confirm');
      return true;
    });
    ui.promptConfirm.mockImplementationOnce(async () => {
      timeline.push('dsh');
      return false;
    });
    hooks.applyInstall.mockImplementation((plan) =>
      Effect.promise(async () => {
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
      timeline.filter((entry) => ['planned', 'confirm', 'apply', 'watcher', 'dsh', 'publish', 'verify'].includes(entry))
    ).toEqual(['planned', 'confirm', 'apply', 'verify', 'watcher', 'dsh', 'publish']);
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

  it.each(['npx', 'absolute'] as const)(
    'rewrites the shim from %s to the other mode without changing installed registrations on repeated setup',
    async (initialMode) => {
      vi.stubEnv('AGENT_PRESENCE_CLI_PATH', '/work/presence/dist/src/cli.js');
      await setup([...argumentsForSetup, '--hook-command', initialMode], {}, fixture.layer);
      const before = await snapshotTargets();
      const shim = join(fixture.presenceHome, 'bin/agent-presence');
      const initialShim = await readFile(shim, 'utf8');
      const npxCommand = 'exec npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@';
      const absoluteShim = `#!/bin/sh\nexec ${shellQuote(process.execPath)} /work/presence/dist/src/cli.js "$@"\n`;
      if (initialMode === 'npx') {
        expect(initialShim).toContain(npxCommand);
      } else {
        expect(initialShim).toBe(absoluteShim);
      }

      await setup(
        [...argumentsForSetup, '--hook-command', initialMode === 'npx' ? 'absolute' : 'npx'],
        {},
        fixture.layer
      );

      expect(process.exitCode).toBe(0);
      if (initialMode === 'npx') {
        expect(await readFile(shim, 'utf8')).toBe(absoluteShim);
      } else {
        expect(await readFile(shim, 'utf8')).toContain(npxCommand);
      }
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
    expect(output()).toContain(
      'Existing artifacts for unselected agents are left unchanged; run uninstall to remove them.'
    );
    expect(fixture.processCalls).toEqual([]);
  });

  it('counts configuration-only evidence without running version commands or reading credential files', async () => {
    const credential = join(fixture.home, '.codex/auth.json');
    await put(credential, '{"fixture":"must not be read"}\n');
    await mkdir(join(fixture.home, '.claude'));
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
    const path = join(fixture.home, '.grok');
    const canonicalPath = join(await realpath(fixture.home), '.grok');
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

  it('skips hook planning, shim, confirmation and verification when nothing is found and continues independent steps', async () => {
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
    expect(existsSync(join(fixture.presenceHome, 'bin/agent-presence'))).toBe(false);
    expect(dependencies.runScripts).toHaveBeenCalledOnce();
    expect(dependencies.publish).toHaveBeenCalledOnce();
    expect(output()).toContain('No agents detected; setup installed no hooks.');
    expect(ui.finishOutro).toHaveBeenCalledExactlyOnceWith('setup: ok');
    expect(timeline.filter((entry) => ['watcher', 'publish'].includes(entry))).toEqual(['watcher', 'publish']);
  });

  it('leaves earlier unselected artifacts and their ledger records untouched during setup verification', async () => {
    await setup([...detectedSetupArguments, '--agents', 'pi'], {}, fixture.layer);
    const path = join(fixture.home, '.pi/agent/extensions/agent-presence.ts');
    await writeFile(path, '// user change must remain untouched\n');
    const before = (await fixture.run(realHarness.inventory())).entries.filter((entry) => entry.agents.includes('pi'));
    timeline = [];
    hooks.verify.mockClear();

    await setup([...detectedSetupArguments, '--agents', 'grok'], {}, fixture.layer);

    expect(process.exitCode).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('// user change must remain untouched\n');
    expect((await fixture.run(realHarness.inventory())).entries.filter((entry) => entry.agents.includes('pi'))).toEqual(
      before
    );
    expect(hooks.verify).toHaveBeenCalledExactlyOnceWith('agent-presence', {
      bundle: expect.any(Object),
      agents: ['grok']
    });
    expect(output()).not.toContain(`verify drift: ${path}`);
    expect(output()).toContain(
      'Existing artifacts for unselected agents are left unchanged; run uninstall to remove them.'
    );
  });
});
