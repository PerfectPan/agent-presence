import { mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import * as harness from '@rivus/agent-kit/harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { doctor } from '../src/cli/commands/doctor.js';
import { setup } from '../src/cli/commands/setup.js';
import * as harnessRoot from '../src/cli/harness.js';
import { PREVIOUS_RELEASE_MARKERS } from '../src/cli/setup-legacy.js';
import { createPresenceBundle, PRESENCE_AGENTS } from '../src/harness/bundle.js';
import { queuePaths } from '../src/queue/files.js';
import {
  buildOpenCodePluginSource,
  installPreviousRelease,
  previousReleasePaths,
  uninstallPreviousRelease
} from './fixtures/previous-release.js';
import { AGENT_HOME_VARIABLES, createHarnessFixture, HARNESS_NOW, type HarnessFixture } from './harness-support.js';

const ui = vi.hoisted(() => ({
  isInteractiveTerminal: vi.fn<typeof import('../src/cli/ui.js').isInteractiveTerminal>(() => true),
  promptConfirm: vi.fn<typeof import('../src/cli/ui.js').promptConfirm>(async () => true),
  promptSelect: vi.fn<typeof import('../src/cli/ui.js').promptSelect>(async () => 'cancel'),
  showInfo: vi.fn<(message: string) => void>(),
  showNote: vi.fn<(message: string, title?: string) => void>(),
  finishOutro: vi.fn<typeof import('../src/cli/ui.js').finishOutro>()
}));
const boundary = vi.hoisted(() => ({
  cleanup: vi.fn<typeof import('../src/migration.js').cleanupMigratedLegacyHome>(async () => ({
    from: '',
    to: '',
    removed: []
  })),
  hasLegacy: vi.fn<typeof import('../src/migration.js').hasLegacyHomeToMigrate>(async () => false),
  migrate: vi.fn<typeof import('../src/migration.js').migrateLegacyHome>(),
  login: vi.fn<typeof import('../src/cli/commands/login.js').login>(async () => {}),
  hasCredential: vi.fn<typeof import('../src/cli/credential.js').hasCredential>(async () => false),
  scripts: vi.fn<typeof import('../src/setup.js').runSetupScripts>(async () => [])
}));

vi.mock('../src/cli/ui.js', () => ({
  ...ui,
  startIntro: vi.fn<typeof import('../src/cli/ui.js').startIntro>(),
  promptText: vi.fn<typeof import('../src/cli/ui.js').promptText>(),
  createSpinner: () => ({ start: vi.fn<(message?: string) => void>(), stop: vi.fn<(message?: string) => void>() })
}));
vi.mock('../src/migration.js', () => ({
  cleanupMigratedLegacyHome: boundary.cleanup,
  hasLegacyHomeToMigrate: boundary.hasLegacy,
  migrateLegacyHome: boundary.migrate
}));
vi.mock('../src/cli/commands/login.js', () => ({ login: boundary.login }));
vi.mock('../src/cli/credential.js', () => ({ hasCredential: boundary.hasCredential }));
vi.mock('../src/secret.js', () => ({
  readCredential: vi.fn<typeof import('../src/secret.js').readCredential>(async () => undefined)
}));
vi.mock('../src/setup.js', () => ({
  LINUX_WATCHER_SKIP_MESSAGE: 'watcher skipped',
  runSetupScripts: boundary.scripts
}));
vi.mock('../src/platform.js', () => ({ isMacOS: () => false }));

const OVERRIDES = [
  'CLAUDE_SETTINGS_FILE',
  'GEMINI_SETTINGS_FILE',
  'CODEX_HOOKS_FILE',
  'OPENCODE_CONFIG',
  'OPENCODE_AGENT_PRESENCE_PLUGIN_FILE',
  'OPENCODE_AGENT_SIGNATURE_PLUGIN_FILE',
  'PI_SETTINGS_FILE',
  'PI_AGENT_PRESENCE_EXTENSION_FILE',
  'PI_AGENT_PRESENCE_EXTENSION_DIR'
];
const ARGS = ['--provider', 'feishu-signature'];
let fixture: HarnessFixture;
let previousExitCode: typeof process.exitCode;
let log: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
const realRunHarness = harnessRoot.runHarness;

beforeEach(async () => {
  fixture = await createHarnessFixture();
  vi.stubEnv('HOME', fixture.home);
  for (const variable of [
    ...AGENT_HOME_VARIABLES,
    ...OVERRIDES,
    'AGENT_PRESENCE_HOME',
    'AGENT_SIGNATURE_HOME',
    'AGENT_PRESENCE_HOOK_COMMAND',
    'AGENT_PRESENCE_CLI_PATH',
    'AGENT_PRESENCE_STATE_PATH',
    'CODEX_THREAD_ID',
    'CODEX_SESSION_ID',
    'DSH_HOME'
  ]) {
    vi.stubEnv(variable, undefined);
  }
  previousExitCode = process.exitCode;
  process.exitCode = 0;
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(HARNESS_NOW);
  ui.promptConfirm.mockResolvedValue(true);
  ui.promptSelect.mockResolvedValue('cancel');
  boundary.hasLegacy.mockResolvedValue(false);
  boundary.hasCredential.mockResolvedValue(false);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(harnessRoot, 'runHarness').mockImplementation((program, layer) => realRunHarness(program, layer));
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

async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      const key = relative(fixture.home, target);
      if (entry.isSymbolicLink()) {
        files[key] = `symlink:${await readlink(target)}`;
      } else if (entry.isDirectory()) {
        files[`${key}/`] = '';
        await walk(target);
      } else {
        files[key] = (await readFile(target)).toString('base64');
      }
    }
  }
  await walk(fixture.home);
  return files;
}

function output(): string {
  return ui.showInfo.mock.calls.map(([message]) => message).join('\n');
}

async function seedQueue(): Promise<void> {
  const paths = queuePaths(join(fixture.presenceHome, 'state.json'));
  await put(paths.disabled, '');
  await put(paths.epoch, '7\n');
  await put(join(paths.queueDir, `${HARNESS_NOW}-42-record.json`), '{"fixture":"untouched"}\n');
}

async function expectRefusal(before: Record<string, string>): Promise<void> {
  expect(process.exitCode).toBe(1);
  expect(errors).not.toHaveBeenCalled();
  expect(output()).toContain('setup refused:');
  expect(boundary.login).not.toHaveBeenCalled();
  expect(boundary.hasCredential).not.toHaveBeenCalled();
  expect(ui.promptConfirm).not.toHaveBeenCalled();
  expect(ui.promptSelect).not.toHaveBeenCalled();
  expect(boundary.scripts).not.toHaveBeenCalled();
  expect(fixture.cliCalls).toEqual([]);
  expect(fixture.processCalls).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect(harnessRoot.runHarness).toHaveBeenCalledOnce();
}

async function installManaged(): Promise<void> {
  await fixture.writeShim();
  const plan = await fixture.run(harness.planInstall(createPresenceBundle(), { agents: PRESENCE_AGENTS }));
  await fixture.run(harness.applyInstall(plan));
}

describe('previous-release setup check', () => {
  it.each([
    { commandMode: 'npx', installMode: 'npx' },
    { commandMode: 'npx', installMode: 'absolute' },
    { commandMode: 'absolute', installMode: 'npx' },
    { commandMode: 'absolute', installMode: 'absolute' }
  ] as const)(
    'lists old $commandMode generators before a new $installMode install without touching targets, queues, login or confirmation',
    async ({ commandMode, installMode }) => {
      await installPreviousRelease({ homeDir: fixture.home, commandMode });
      await seedQueue();
      const paths = previousReleasePaths(fixture.home);
      const before = await snapshot();

      await setup([...ARGS, '--hook-command', installMode], {}, fixture.layer);

      await expectRefusal(before);
      expect(output()).toContain(`${paths.opencodePlugin}; kind=file; treatment=replace`);
      expect(output()).toContain(`${paths.piExtension}; kind=file; treatment=replace`);
      expect(output()).toContain(paths.opencodeConfig);
      expect(output()).toContain('npx --yes @rivus/agent-presence@0.9.0 uninstall');
      expect(output()).toContain('without --credentials or --all');
      expect(output()).toContain('node <checkout>/dist/src/cli.js uninstall');
      if (commandMode === 'npx') {
        for (const path of [paths.claudeSettings, paths.codexHooks, paths.geminiSettings]) {
          expect(output()).toContain(path);
        }
        expect(output()).toContain('event=SessionStart; command=npx');
        expect(output()).toContain('gemini-cli:');
      } else {
        expect(output()).not.toContain(paths.claudeSettings);
        expect(output()).not.toContain(paths.codexHooks);
        expect(output()).not.toContain(paths.geminiSettings);
      }
    }
  );

  it.each(['claudeSettings', 'codexHooks', 'geminiSettings'] as const)(
    'refuses a pinned npx command in %s alone, including the old Gemini event names',
    async (key) => {
      await installPreviousRelease({ homeDir: fixture.home, commandMode: 'npx' });
      const paths = previousReleasePaths(fixture.home);
      const content = (await readFile(paths[key], 'utf8')).replaceAll('@0.9.0', '@0.7.2');
      for (const path of Object.values(paths)) {
        await rm(path, { force: true });
      }
      await put(paths[key], content);
      await seedQueue();
      const before = await snapshot();
      await setup(ARGS, {}, fixture.layer);
      await expectRefusal(before);
      expect(output()).toContain(paths[key]);
      expect(output()).toContain('@rivus/agent-presence@0.7.2 uninstall');
      expect(output()).not.toContain('@rivus/agent-presence@0.9.0 uninstall');
      if (key === 'geminiSettings') {
        expect(output()).toContain('gemini-cli:');
        expect(output()).toContain('event=UserPromptSubmit');
      }
    }
  );

  it.each(['agent-presence hook', 'agent-signature hook', 'node /work/agent-signature.mjs hook'])(
    'recognizes earlier command spelling %s with the fallback remedy',
    async (command) => {
      const path = previousReleasePaths(fixture.home).claudeSettings;
      await put(path, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } }));
      const before = await snapshot();
      await setup(ARGS, {}, fixture.layer);
      await expectRefusal(before);
      expect(output()).toContain(`command=${command}`);
      expect(output()).toContain('@rivus/agent-presence@0.9.0 uninstall');
    }
  );

  it.each(['./plugins/agent-presence.js', './plugins/agent-signature.js'])(
    'recognizes standalone opencode reference %s with the fallback remedy',
    async (reference) => {
      const path = previousReleasePaths(fixture.home).opencodeConfig;
      await put(path, JSON.stringify({ plugin: [reference] }));
      const before = await snapshot();
      await setup(ARGS, {}, fixture.layer);
      await expectRefusal(before);
      expect(output()).toContain(path);
      expect(output()).toContain('@rivus/agent-presence@0.9.0 uninstall');
    }
  );

  it.each(['claudeSettings', 'codexHooks', 'geminiSettings'] as const)(
    'accepts the documented marker-free absolute command gap in %s alone',
    async (key) => {
      await installPreviousRelease({ homeDir: fixture.home, commandMode: 'absolute' });
      const paths = previousReleasePaths(fixture.home);
      const content = await readFile(paths[key], 'utf8');
      for (const path of Object.values(paths)) {
        await rm(path, { force: true });
      }
      await put(paths[key], content);
      await setup(ARGS, {}, fixture.layer);
      expect(process.exitCode).toBe(0);
      expect(output()).not.toContain('setup refused');
      expect(await readFile(paths[key], 'utf8')).toBe(content);
    }
  );

  it.each(['npx', 'absolute'] as const)(
    'detects each old bridge and config reference alone in %s mode with fallback remedy',
    async (commandMode) => {
      await installPreviousRelease({ homeDir: fixture.home, commandMode });
      const paths = previousReleasePaths(fixture.home);
      const selected = [paths.opencodePlugin, paths.piExtension, paths.opencodeConfig];
      const contents = await Promise.all(selected.map((path) => readFile(path, 'utf8')));
      for (const path of Object.values(paths)) {
        await rm(path, { force: true });
      }
      for (const [index, path] of selected.entries()) {
        await put(path, contents[index]!);
        const before = await snapshot();
        await setup(ARGS, {}, fixture.layer);
        await expectRefusal(before);
        expect(output()).toContain(path);
        expect(output()).toContain('@rivus/agent-presence@0.9.0 uninstall');
        await rm(path);
        vi.clearAllMocks();
        process.exitCode = 0;
      }
    }
  );

  it.each(['bridge', 'reference'] as const)(
    'adds the fallback alongside distinct pinned versions for a %s',
    async (kind) => {
      await put(
        join(fixture.home, '.claude/settings.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: 'command', command: 'npx --yes @rivus/agent-presence@0.7.2 hook' },
                  { type: 'command', command: 'npx --yes @rivus/agent-presence@0.8.1 hook # edited' }
                ]
              }
            ]
          }
        })
      );
      const copy =
        kind === 'bridge'
          ? join(fixture.home, '.config/opencode/plugins/presence-copy.js')
          : previousReleasePaths(fixture.home).opencodeConfig;
      await put(
        copy,
        kind === 'bridge' ? buildOpenCodePluginSource() : JSON.stringify({ plugin: ['./plugins/agent-presence.js'] })
      );
      const before = await snapshot();
      await setup(ARGS, {}, fixture.layer);
      await expectRefusal(before);
      expect(output()).toContain('@rivus/agent-presence@0.7.2 uninstall');
      expect(output()).toContain('@rivus/agent-presence@0.8.1 uninstall');
      expect(output()).toContain('@rivus/agent-presence@0.9.0 uninstall');
      expect(output()).toContain(copy);
      expect(output()).toContain('renamed copies or hand-edited entries');
      expect(output()).not.toContain('npx @rivus/agent-presence uninstall');
    }
  );

  it.each(['dotfiles-managed', 'symlinked'] as const)(
    'refuses an old hook in a %s settings file before unrelated conflict resolution',
    async (kind) => {
      await installPreviousRelease({ homeDir: fixture.home, commandMode: 'npx' });
      const path = previousReleasePaths(fixture.home).claudeSettings;
      if (kind === 'dotfiles-managed') {
        fixture.managedPaths.set(await realpath(path), 'fixture-dotfiles');
      } else {
        const destination = join(fixture.home, 'shared-settings.json');
        await writeFile(destination, await readFile(path));
        await rm(path);
        await symlink(destination, path);
      }
      const conflict = join(fixture.home, '.claude/skills/agent-presence/keep.txt');
      await put(conflict, 'untracked plugin\n');
      if (kind === 'dotfiles-managed') {
        fixture.managedPaths.set(await realpath(dirname(conflict)), 'fixture-dotfiles');
      }
      await seedQueue();
      const before = await snapshot();
      await setup(ARGS, {}, fixture.layer);
      await expectRefusal(before);
      expect(output()).toContain(path);
      expect(output()).toContain('treatment=replace');
    }
  );

  it.each([false, true])('protects a user-kept file before any uninstall remedy (mixed=%s)', async (mixed) => {
    await installManaged();
    const path = previousReleasePaths(fixture.home).piExtension;
    await writeFile(path, '// @rivus/agent-presence pi extension\n// user kept this copy\n');
    await fixture.run(harness.uninstall('agent-presence', { agents: PRESENCE_AGENTS }));
    if (mixed) {
      await put(previousReleasePaths(fixture.home).opencodePlugin, buildOpenCodePluginSource());
    }
    fixture.cliCalls.length = 0;
    const before = await snapshot();
    await setup(ARGS, {}, fixture.layer);
    await expectRefusal(before);
    expect(output()).toContain(`${path}; kind=file; treatment=protect`);
    expect(output()).toContain('your kept file');
    expect(output()).toContain('Move or remove it by hand');
    if (mixed) {
      expect(output()).toContain('before uninstalling replacement entries');
      expect(output().indexOf('your kept file')).toBeLessThan(output().indexOf('npx --yes'));
      expect(output()).toContain('For replace entries, after moving or removing any kept files above');
    } else {
      expect(output()).not.toContain('before uninstalling replacement entries');
      expect(output()).not.toContain('previous-release');
      expect(output()).not.toMatch(/npx|node <checkout>/);
    }
  });

  it('describes a current-version Grok hook kept by uninstall as a kept file, not a previous release', async () => {
    await installManaged();
    const path = join(fixture.home, '.grok/hooks/agent-presence.json');
    const installed = await readFile(path, 'utf8');
    expect(installed).toContain('agent-presence hook');
    await writeFile(path, `${installed}\n`);
    await fixture.run(harness.uninstall('agent-presence', { agents: PRESENCE_AGENTS }));
    fixture.cliCalls.length = 0;
    await seedQueue();
    const before = await snapshot();

    await setup(ARGS, {}, fixture.layer);

    await expectRefusal(before);
    expect(output()).toContain('setup refused: files kept from an earlier removal remain:');
    expect(output()).toContain(`${path}; kind=file; treatment=protect`);
    expect(output()).toContain('Move or remove it by hand');
    expect(output()).not.toContain('previous-release');
    expect(output()).not.toMatch(/npx|node <checkout>/);
  });

  it('leaves a tracked bridge overwrite to the ordinary user-modified force conflict', async () => {
    await installManaged();
    const path = previousReleasePaths(fixture.home).opencodePlugin;
    await writeFile(path, buildOpenCodePluginSource());
    const before = await snapshot();
    await setup(ARGS, {}, fixture.layer);
    expect(process.exitCode).toBe(1);
    expect(output()).not.toContain('previous-release entries remain');
    expect(output()).toContain('user-modified');
    expect(ui.promptSelect).toHaveBeenCalledOnce();
    expect(ui.promptSelect.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        options: [expect.objectContaining({ value: 'force' }), expect.objectContaining({ value: 'cancel' })]
      })
    );
    expect(await snapshot()).toEqual(before);
  });

  it('runs the check after migration but before the migrated queue can be recovered', async () => {
    boundary.hasLegacy.mockResolvedValue(true);
    boundary.migrate.mockImplementation(async () => {
      await put(previousReleasePaths(fixture.home).piExtension, '// @rivus/agent-presence pi extension\n');
      await seedQueue();
      return { status: 'migrated', from: 'old', to: 'new', copied: [], removed: [], skipped: [] };
    });
    await setup(ARGS, {}, fixture.layer);
    expect(boundary.migrate).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('previous-release entries remain');
    expect(boundary.login).not.toHaveBeenCalled();
    expect(await readFile(queuePaths(join(fixture.presenceHome, 'state.json')).epoch, 'utf8')).toBe('7\n');
  });

  it.each(OVERRIDES)('warns about %s before the check on refused and clean runs', async (variable) => {
    vi.stubEnv(variable, '/work/custom-target');
    const path = previousReleasePaths(fixture.home).piExtension;
    await put(path, '// @rivus/agent-presence pi extension\n');
    const before = await snapshot();
    await setup(ARGS, {}, fixture.layer);
    await expectRefusal(before);
    expect(output()).toContain(`${variable} is set; this version ignores it`);
    expect(output()).toContain(`uninstall with ${variable} set to the same value`);
    expect(output().indexOf(`${variable} is set`)).toBeLessThan(output().indexOf('setup refused'));
    await rm(path);
    ui.showInfo.mockClear();
    process.exitCode = 0;
    await setup(ARGS, {}, fixture.layer);
    expect(process.exitCode).toBe(0);
    expect(output()).toContain(`${variable} is set; this version ignores it`);
  });

  it('skips the check and all harness work with --no-hooks', async () => {
    await installPreviousRelease({ homeDir: fixture.home, commandMode: 'npx' });
    const before = await snapshot();
    await setup([...ARGS, '--no-hooks'], {}, fixture.layer);
    expect(process.exitCode).toBe(0);
    expect(output()).not.toContain('setup refused');
    expect(harnessRoot.runHarness).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it.each(['npx', 'absolute'] as const)(
    'doctor matches the expanded installed command when the shim path is quoted (%s)',
    async (mode) => {
      vi.stubEnv('AGENT_PRESENCE_HOME', join(fixture.home, 'presence home'));
      vi.stubEnv('AGENT_PRESENCE_CLI_PATH', '/work/checkout/dist/src/cli.js');
      await setup([...ARGS, '--hook-command', mode], {}, fixture.layer);
      expect(process.exitCode).toBe(0);
      await put(
        join(fixture.home, '.claude/settings.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'npx --yes @rivus/agent-presence@0.8.1 hook --source claude' }] }
            ]
          }
        })
      );
      await doctor([], fixture.layer);
      expect(log.mock.calls.flat().join('\n')).toContain('duplicate-hook');
      expect(log.mock.calls.flat().join('\n')).toContain('runs 2 hooks of one application');
    }
  );

  it.each(['npx', 'absolute'] as const)(
    'installs once after old fixtures are removed, preserves foreign files, and doctor sees later old entries (%s)',
    async (mode) => {
      const foreign = {
        [join(fixture.home, '.pi/agent/extensions/team.ts')]:
          'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nexport default (pi: ExtensionAPI) => { pi.on("before_agent_start", () => {}); };\n',
        [join(fixture.home, '.pi/agent/extensions/check.ts')]:
          'import { existsSync } from "node:fs";\nexport const present = existsSync(new URL("./agent-presence.ts", import.meta.url));\n',
        [join(fixture.home, '.config/opencode/plugins/team.js')]:
          'function mapEvent(event) { return event; }\nexport default mapEvent;\n',
        [join(fixture.home, '.config/opencode/plugins/audit.js')]:
          'export const run = () => "/work/team-audit/dist/src/cli.js hook --source audit";\n',
        [join(fixture.home, '.claude/settings.json')]: JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: '/work/team-audit/dist/src/cli.js hook --source audit' }] }
            ]
          }
        })
      };
      for (const [path, content] of Object.entries(foreign)) {
        expect(PREVIOUS_RELEASE_MARKERS.some((marker) => content.includes(marker))).toBe(false);
        await put(path, content);
      }
      await installPreviousRelease({ homeDir: fixture.home, commandMode: 'npx' });
      await uninstallPreviousRelease({ homeDir: fixture.home });
      // The old uninstaller intentionally removes the foreign absolute command; restore it before this install.
      await put(join(fixture.home, '.claude/settings.json'), foreign[join(fixture.home, '.claude/settings.json')]!);
      vi.stubEnv('AGENT_PRESENCE_CLI_PATH', '/work/checkout/dist/src/cli.js');
      await setup([...ARGS, '--hook-command', mode], {}, fixture.layer);
      expect(process.exitCode).toBe(0);
      expect(harnessRoot.runHarness).toHaveBeenCalledTimes(2);
      expect(output()).not.toContain('setup refused');
      for (const [path, content] of Object.entries(foreign)) {
        expect(await readFile(path, 'utf8')).toBe(content);
      }
      const verified = await fixture.run(
        harness.verify('agent-presence', { bundle: createPresenceBundle(), agents: PRESENCE_AGENTS })
      );
      expect(verified.artifacts.every((artifact) => ['in-sync', 'ledger-behind'].includes(artifact.status))).toBe(true);
      // A foreign command's missing executable is outside duplicate detection.
      await rm(join(fixture.home, '.claude/settings.json'));
      process.exitCode = 0;
      await doctor([], fixture.layer);
      expect(process.exitCode).toBe(0);
      expect(log.mock.calls.flat().join('\n')).not.toContain('duplicate-hook');
      await put(
        join(fixture.home, '.claude/settings.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'npx --yes @rivus/agent-presence@0.8.1 hook --source claude' }] }
            ]
          }
        })
      );
      log.mockClear();
      await doctor([], fixture.layer);
      expect(process.exitCode).toBe(1);
      expect(log.mock.calls.flat().join('\n')).toContain('duplicate-hook');
      expect(log.mock.calls.flat().join('\n')).toContain('runs 2 hooks of one application');
      const leftover = await readFile(join(fixture.home, '.claude/settings.json'), 'utf8');
      await fixture.run(harness.uninstall('agent-presence', { agents: PRESENCE_AGENTS }));
      expect(await readFile(join(fixture.home, '.claude/settings.json'), 'utf8')).toBe(leftover);
      for (const [path, content] of Object.entries(foreign).filter(([path]) => !path.endsWith('settings.json'))) {
        expect(await readFile(path, 'utf8')).toBe(content);
      }
      expect(fixture.processCalls).toEqual([]);
    }
  );
});
